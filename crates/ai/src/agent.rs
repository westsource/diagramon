//! 受控工具循环：模型可以调用**一组固定的、只作用于内存文档模型**的工具，循环若干步后收束。
//!
//! 这是整个 AI 能力里唯一带"自主性"的地方，所以三条边界写死在这里：
//!
//! 1. **工具是本进程内的一组固定实现**，不是模型能任意扩展的东西。工具的签名与语义
//!    由我们定义（读文档 / 取格式语法 / 校验 / 应用补丁），模型只能**选择调哪个**。
//!    没有任何工具接触文件系统、shell 或网络 —— 这是与通用编码 agent 最本质的分歧点。
//! 2. **步数有硬上限**。每一轮都是真实计费的调用，"再试一次"必须有尽头。
//! 3. **工具的错误也是工具结果**：参数没解析出来、工具执行失败、工具名不存在 ——
//!    一律作为 `role="tool"` 的内容回给模型，让它自己纠正。让模型看见错误，比让整轮
//!    请求 400 有用得多，而且不会把一次可恢复的失误变成一次失败计费。
//!
//! 循环本身**不碰网络**：模型调用经 `Completer` 注入，所以整套流程可以在单测里
//! 用脚本化的假模型跑完（见文件末尾的测试）。

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use crate::provider::{
    apply_identity, build_body_with_tools, text_of, truncate, with_max_tokens_ceiling, ChatError,
    Resolved,
};

/// 发一次非流式请求。抽出来只为让"超限自愈"能原样再发一次同一个形状。
async fn post(
    client: &reqwest::Client,
    r: &Resolved,
    body: Value,
) -> Result<reqwest::Response, ChatError> {
    let mut request = apply_identity(client.post(r.endpoint()).json(&body), r);
    if let Some(key) = r.api_key.as_deref() {
        if !key.trim().is_empty() {
            request = request.bearer_auth(key.trim());
        }
    }
    request.send().await.map_err(|e| ChatError::Network(e.to_string()))
}

/// 非 2xx 收成 `ChatError::Http`（与 `provider::chat_once` 同一口径：截 600 字符）。
///
/// 截断长度够用：超限报文是 `… valid range of max_tokens is [1, 393216]`，约 250 字符。
async fn http_error(resp: reqwest::Response) -> ChatError {
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    ChatError::Http { status, body: truncate(&text, 600) }
}

/// 箱装的 future。
///
/// 手写而不是引 `async-trait`：这个 crate 只要这一处，多一个依赖换不来什么。
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 步数上限。5 步已经够"读一遍 → 校验 → 改 → 再校验"走完；再多是模型在绕圈，
/// 而每一步都是真实计费的调用。
pub const DEFAULT_MAX_STEPS: usize = 5;

/// 单次模型调用的产出。
#[derive(Debug, Clone, Default)]
pub struct Completion {
    /// 正文（可能为空：只决定调用工具时通常没有正文）
    pub text: String,
    /// **原始** `tool_calls` 数组（原样回填 assistant 消息，别重新构造 ——
    /// `id` 必须逐字不变，否则 tool 结果对不上号）。
    pub tool_calls: Vec<Value>,
}

/// 面向循环的"调一次模型"。`tools` 是工具 schema 列表（空 = 不启用工具）。
///
/// 要求 `Send + Sync` 是因为循环整体跑在 Tauri 的多线程运行时里 ——
/// `&dyn Completer` 要能跨 await 点活着，trait 对象本身就得是线程安全的。
pub trait Completer: Send + Sync {
    fn complete<'a>(
        &'a self,
        messages: Vec<Value>,
        tools: Vec<Value>,
    ) -> BoxFuture<'a, Result<Completion, ChatError>>;
}

/// 一个可被模型调用的工具。
///
/// `call` 是**同步**的：工具只动本进程的内存状态（文档模型），没有 IO ——
/// 一旦某个工具的签名里出现了 async，就说明它想做不该做的事（读文件、发请求）。
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    /// OpenAI 形态的 `{"type":"function","function":{...}}`。
    fn schema(&self) -> Value;
    /// 执行。返回的字符串会作为 `role="tool"` 的内容回给模型，所以**要写给人看**：
    /// 模型读它来决定下一步。
    fn call(&self, args: &Value) -> Result<String, String>;
}

/// 循环为什么停下。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// 模型给出了最终正文
    Final,
    /// 撞上步数上限（不是错误：把最后一轮的正文交出去，让用户看到已完成的进度）
    StepLimit,
    /// 用户取消
    Cancelled,
}

/// 循环结果。`messages` 是**完整的**对话（含所有工具往返），可直接落进会话历史。
#[derive(Debug, Clone)]
pub struct AgentOutcome {
    pub messages: Vec<Value>,
    pub text: String,
    pub steps: usize,
    pub stop: StopReason,
}

impl AgentOutcome {
    /// 循环期间实际执行过的工具调用次数（用于界面提示与用量解释）。
    pub fn tool_calls(&self) -> usize {
        self.messages
            .iter()
            .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
            .count()
    }
}

/// 跑一次受控工具循环。
///
/// `messages` 应当已经装好系统提示词、记忆块、历史与本轮 user 消息 —— 这里只管
/// "把工具往返接上去"，不参与提示词组装。
pub async fn run(
    completer: &dyn Completer,
    mut messages: Vec<Value>,
    tools: &[Box<dyn Tool>],
    max_steps: usize,
    cancel: &AtomicBool,
) -> Result<AgentOutcome, ChatError> {
    let schemas: Vec<Value> = tools.iter().map(|t| t.schema()).collect();
    let max_steps = max_steps.max(1);
    let mut last_text = String::new();

    for step in 1..=max_steps {
        if cancel.load(Ordering::Relaxed) {
            return Ok(AgentOutcome {
                messages,
                text: last_text,
                steps: step - 1,
                stop: StopReason::Cancelled,
            });
        }

        let completion = completer.complete(messages.clone(), schemas.clone()).await?;
        if !completion.text.trim().is_empty() {
            last_text = completion.text.clone();
        }

        if completion.tool_calls.is_empty() {
            messages.push(json!({ "role": "assistant", "content": completion.text }));
            return Ok(AgentOutcome { messages, text: completion.text, steps: step, stop: StopReason::Final });
        }

        // assistant 那一轮的原始形态：**必须带 tool_calls**（且 id 逐字不变），
        // 否则下一轮的 tool 结果无处可指，模型会以为它们是自己凭空冒出来的。
        messages.push(json!({
            "role": "assistant",
            "content": completion.text,
            "tool_calls": completion.tool_calls.clone(),
        }));

        for call in &completion.tool_calls {
            let id = call.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let function = call.get("function");
            let name = function
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let raw_args = function
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .unwrap_or("{}");

            let result = execute(tools, name, raw_args);
            messages.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": result,
            }));
        }
    }

    // 撞上步数上限：把最后一次有内容的正文交出去，而不是报错 ——
    // 用户要的是"尽量做完的图"，不是"因为循环超限所以什么都没有"。
    Ok(AgentOutcome { messages, text: last_text, steps: max_steps, stop: StopReason::StepLimit })
}

/// 执行一次工具调用。**任何失败都变成字符串结果**（回给模型让它自己纠正）。
fn execute(tools: &[Box<dyn Tool>], name: &str, raw_args: &str) -> String {
    let Some(tool) = tools.iter().find(|t| t.name() == name) else {
        return format!("没有名为 {name} 的工具。可用工具：{}", tool_names(tools).join(", "));
    };
    if name.is_empty() {
        return "工具调用缺少名称。".to_string();
    }
    // 上游给的是 JSON 字符串；空串按"无参数"处理（模型经常这么发）
    let args: Value = if raw_args.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(raw_args) {
            Ok(v) => v,
            Err(e) => return format!("工具参数不是合法 JSON（{e}），请重新给出参数。原始内容：{raw_args}"),
        }
    };
    match tool.call(&args) {
        Ok(text) => text,
        Err(e) => format!("工具 {name} 执行失败：{e}"),
    }
}

fn tool_names(tools: &[Box<dyn Tool>]) -> Vec<String> {
    tools.iter().map(|t| t.name().to_string()).collect()
}

/// 真实的模型调用：非流式 + 工具。
///
/// 放在 `agent` 而不是 `provider`：它存在的唯一理由是服务这个循环，而它要的形状
/// （**保留原始的 `tool_calls` 数组**，好原样回填 assistant 消息）也只对循环有意义。
/// `provider::chat_once` 只回文本，工具循环用不了它。
pub struct HttpCompleter<'a> {
    pub client: &'a reqwest::Client,
    pub resolved: &'a Resolved,
}

impl Completer for HttpCompleter<'_> {
    fn complete<'a>(
        &'a self,
        messages: Vec<Value>,
        tools: Vec<Value>,
    ) -> BoxFuture<'a, Result<Completion, ChatError>> {
        Box::pin(async move {
            let r = self.resolved;
            if !r.is_ollama() && r.api_key.as_deref().unwrap_or("").trim().is_empty() {
                return Err(ChatError::MissingKey);
            }

            let mut resolved = r.clone();
            let mut resp =
                post(self.client, &resolved, build_body_with_tools(&resolved, &messages, &tools, false))
                    .await?;
            if !resp.status().is_success() {
                let err = http_error(resp).await;
                // 与对话那条路同一套自愈（见 `provider::with_max_tokens_ceiling`）：
                // 这里**只重发这一步**，已经跑完的步数与工具结果原样留在 `messages` 里。
                let Some(fixed) = with_max_tokens_ceiling(&resolved, &err) else {
                    return Err(err);
                };
                resolved = fixed;
                resp = post(
                    self.client,
                    &resolved,
                    build_body_with_tools(&resolved, &messages, &tools, false),
                )
                .await?;
                if !resp.status().is_success() {
                    return Err(http_error(resp).await);
                }
            }
            let payload: Value = resp.json().await.map_err(|e| ChatError::Protocol(e.to_string()))?;

            let message = if r.is_ollama() {
                payload.get("message").cloned()
            } else {
                payload.pointer("/choices/0/message").cloned()
            }
            .unwrap_or(Value::Null);

            let text = text_of(message.get("content"));
            let tool_calls = message
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            Ok(Completion { text, tool_calls })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 脚本化的假模型：按顺序吐出预设的回复，并记录每次收到的 messages。
    struct Scripted {
        replies: Mutex<Vec<Completion>>,
        seen: Mutex<Vec<Vec<Value>>>,
        seen_tools: Mutex<Vec<Vec<Value>>>,
    }

    impl Scripted {
        fn new(replies: Vec<Completion>) -> Self {
            Self { replies: Mutex::new(replies), seen: Mutex::new(Vec::new()), seen_tools: Mutex::new(Vec::new()) }
        }
    }

    impl Completer for Scripted {
        fn complete<'a>(&'a self, messages: Vec<Value>, tools: Vec<Value>) -> BoxFuture<'a, Result<Completion, ChatError>> {
            self.seen.lock().unwrap().push(messages);
            self.seen_tools.lock().unwrap().push(tools);
            let next = self.replies.lock().unwrap().remove(0);
            Box::pin(async move { Ok(next) })
        }
    }

    /// 一个只记调用、不做 IO 的假工具。
    struct Echo {
        name: String,
        reply: Result<String, String>,
        calls: Mutex<Vec<Value>>,
    }

    impl Echo {
        fn ok(name: &str, reply: &str) -> Self {
            Self { name: name.into(), reply: Ok(reply.into()), calls: Mutex::new(Vec::new()) }
        }
        fn err(name: &str, why: &str) -> Self {
            Self { name: name.into(), reply: Err(why.into()), calls: Mutex::new(Vec::new()) }
        }
    }

    impl Tool for Echo {
        fn name(&self) -> &str {
            &self.name
        }
        fn schema(&self) -> Value {
            json!({"type": "function", "function": {"name": self.name}})
        }
        fn call(&self, args: &Value) -> Result<String, String> {
            self.calls.lock().unwrap().push(args.clone());
            self.reply.clone()
        }
    }

    fn call(id: &str, name: &str, args: &str) -> Value {
        json!({"id": id, "type": "function", "function": {"name": name, "arguments": args}})
    }

    fn user(text: &str) -> Value {
        json!({"role": "user", "content": text})
    }

    /// 模型直接给正文 ⇒ 一步收束，消息里多一条 assistant。
    #[test]
    fn a_direct_answer_stops_immediately() {
        let completer = Scripted::new(vec![Completion { text: "这是流程图".into(), tool_calls: vec![] }]);
        let tools: Vec<Box<dyn Tool>> = vec![];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let out = rt
            .block_on(run(&completer, vec![user("画个流程")], &tools, DEFAULT_MAX_STEPS, &AtomicBool::new(false)))
            .unwrap();
        assert_eq!(out.stop, StopReason::Final);
        assert_eq!(out.steps, 1);
        assert_eq!(out.text, "这是流程图");
        assert_eq!(out.messages.len(), 2); // user + assistant
    }

    /// 完整的工具往返：assistant(tool_calls) → tool(结果) → assistant(正文)。
    ///
    /// 这个顺序与 `id` 的逐字保留是循环能不能收敛的全部关键：id 变了或 tool_calls
    /// 丢了，模型下一轮就看不到自己调过什么。
    #[test]
    fn a_tool_round_trip_keeps_ids_and_order() {
        let tool = Echo::ok("read_document", "flowchart TD\n A-->B");
        let completer = Scripted::new(vec![
            Completion { text: String::new(), tool_calls: vec![call("call_1", "read_document", "{}")] },
            Completion { text: "改好了".into(), tool_calls: vec![] },
        ]);
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(tool)];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let out = rt
            .block_on(run(&completer, vec![user("改一下")], &tools, DEFAULT_MAX_STEPS, &AtomicBool::new(false)))
            .unwrap();

        assert_eq!(out.stop, StopReason::Final);
        assert_eq!(out.steps, 2);
        assert_eq!(out.tool_calls(), 1);

        let roles: Vec<&str> = out.messages.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["user", "assistant", "tool", "assistant"]);

        let assistant = &out.messages[1];
        assert_eq!(assistant["tool_calls"][0]["id"], "call_1");
        assert_eq!(assistant["tool_calls"][0]["function"]["name"], "read_document");
        // content 为空也要留着（有的上游收空串、有的收 null；这里统一给空串）
        assert_eq!(assistant["content"], "");

        let tool_message = &out.messages[2];
        assert_eq!(tool_message["tool_call_id"], "call_1");
        assert!(tool_message["content"].as_str().unwrap().contains("flowchart"));
    }

    /// 工具 schema 每一轮都要带上去 —— 少带一轮，模型就"忘了自己有什么工具"。
    #[test]
    fn tool_schemas_are_sent_on_every_step() {
        let completer = Scripted::new(vec![
            Completion { text: String::new(), tool_calls: vec![call("c1", "read_document", "{}")] },
            Completion { text: "完成".into(), tool_calls: vec![] },
        ]);
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(Echo::ok("read_document", "x"))];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(run(&completer, vec![user("hi")], &tools, DEFAULT_MAX_STEPS, &AtomicBool::new(false))).unwrap();

        let sent = completer.seen_tools.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|t| t.len() == 1), "每一轮都要带工具 schema");
    }

    /// 工具**执行失败**也要作为 tool 结果回给模型（让它自己纠正），
    /// 而不是让整轮请求失败 —— 一次可恢复的失误不该变成一次失败计费。
    #[test]
    fn tool_errors_come_back_as_results_not_failures() {
        let tool = Echo::err("validate", "第 3 行括号没闭合");
        let completer = Scripted::new(vec![
            Completion { text: String::new(), tool_calls: vec![call("c1", "validate", "{}")] },
            Completion { text: "已修正".into(), tool_calls: vec![] },
        ]);
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(tool)];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let out = rt
            .block_on(run(&completer, vec![user("看一下")], &tools, DEFAULT_MAX_STEPS, &AtomicBool::new(false)))
            .unwrap();
        assert_eq!(out.stop, StopReason::Final, "工具失败不该让整轮失败");
        let content = out.messages[2]["content"].as_str().unwrap();
        assert!(content.contains("执行失败") && content.contains("括号"), "{content}");
    }

    /// 参数不是合法 JSON、工具名不存在 —— 同样回给模型，并**说清可用工具有哪些**。
    #[test]
    fn bad_arguments_and_unknown_tools_are_explained_to_the_model() {
        let completer = Scripted::new(vec![
            Completion { text: String::new(), tool_calls: vec![call("c1", "read_document", "{不是 JSON")] },
            Completion { text: String::new(), tool_calls: vec![call("c2", "no_such_tool", "{}")] },
            Completion { text: "好".into(), tool_calls: vec![] },
        ]);
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(Echo::ok("read_document", "x"))];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let out = rt
            .block_on(run(&completer, vec![user("hi")], &tools, DEFAULT_MAX_STEPS, &AtomicBool::new(false)))
            .unwrap();

        let bad_json = out.messages[2]["content"].as_str().unwrap();
        assert!(bad_json.contains("不是合法 JSON"), "{bad_json}");
        let unknown = out.messages[4]["content"].as_str().unwrap();
        assert!(unknown.contains("没有名为 no_such_tool 的工具"), "{unknown}");
        assert!(unknown.contains("read_document"), "要告诉模型有哪些工具可用：{unknown}");
    }

    /// 空 `arguments` 按"无参数"处理（模型经常这么发），不该被当成解析失败。
    #[test]
    fn empty_arguments_count_as_no_arguments() {
        let tool = Echo::ok("read_document", "ok");
        let completer = Scripted::new(vec![
            Completion { text: String::new(), tool_calls: vec![call("c1", "read_document", "")] },
            Completion { text: "好".into(), tool_calls: vec![] },
        ]);
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(tool)];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(run(&completer, vec![user("hi")], &tools, DEFAULT_MAX_STEPS, &AtomicBool::new(false))).unwrap();
        // 走到这里说明没有报"参数不合法"
    }

    /// 撞上步数上限：**不报错**，把最后一次有内容的正文交出去
    /// （用户要的是尽量做完的图，不是"因为超限所以什么都没有"）。
    #[test]
    fn hitting_the_step_limit_returns_the_last_text_instead_of_failing() {
        let tool = Echo::ok("read_document", "x");
        let forever = (0..8)
            .map(|i| Completion { text: format!("第{i}版"), tool_calls: vec![call(&format!("c{i}"), "read_document", "{}")] })
            .collect();
        let completer = Scripted::new(forever);
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(tool)];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let out = rt
            .block_on(run(&completer, vec![user("hi")], &tools, 3, &AtomicBool::new(false)))
            .unwrap();
        assert_eq!(out.stop, StopReason::StepLimit);
        assert_eq!(out.steps, 3);
        assert_eq!(out.text, "第2版");
        assert_eq!(out.tool_calls(), 3);
    }

    /// 取消：立刻停下，把已完成的部分交出去，**不再发新的模型调用**。
    #[test]
    fn cancel_stops_before_the_next_model_call() {
        let completer = Scripted::new(vec![Completion { text: "不该被用到".into(), tool_calls: vec![] }]);
        let tools: Vec<Box<dyn Tool>> = vec![];
        let cancel = AtomicBool::new(true);
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let out = rt.block_on(run(&completer, vec![user("hi")], &tools, DEFAULT_MAX_STEPS, &cancel)).unwrap();
        assert_eq!(out.stop, StopReason::Cancelled);
        assert_eq!(out.steps, 0);
        assert!(completer.seen.lock().unwrap().is_empty(), "取消后不该再调模型");
    }

    /// 步数上限至少为 1：传 0 也不能变成"一次都不调"（那是静默失败）。
    #[test]
    fn step_limit_is_never_zero() {
        let completer = Scripted::new(vec![Completion { text: "答".into(), tool_calls: vec![] }]);
        let tools: Vec<Box<dyn Tool>> = vec![];
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let out = rt
            .block_on(run(&completer, vec![user("hi")], &tools, 0, &AtomicBool::new(false)))
            .unwrap();
        assert_eq!(out.steps, 1);
        assert_eq!(out.stop, StopReason::Final);
    }

    /// 工具循环里的 `max_tokens` 超限自愈：第一次 400（带范围说明）→ **只重发这一步**，
    /// 第二次请求体里必须换成上游给的上限，循环照常收束。
    #[test]
    fn http_completer_heals_a_rejected_max_tokens_once() {
        use std::io::{Read, Write};
        use std::sync::{Arc, Mutex};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let Ok(mut s) = stream else { continue };
                let mut buf = vec![0u8; 16384];
                let n = Read::read(&mut s, &mut buf).unwrap_or(0);
                sink.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                let first = sink.lock().unwrap().len() == 1;
                let (status, body) = if first {
                    ("400 Bad Request", "{\"error\":{\"message\":\"Invalid max_tokens value, the valid range of max_tokens is [1, 393216]\"}}")
                } else {
                    ("200 OK", "{\"choices\":[{\"message\":{\"content\":\"好的\"}}]}")
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });

        let client = reqwest::Client::new();
        let r = Resolved {
            provider: "openai".into(),
            base_url: format!("http://{addr}/v1"),
            model: "m".into(),
            api_key: Some("sk-x".into()),
            max_tokens: Some(393220), // 与真机那份 settings 一样：比上限大 4
            temperature: Some(0.2),
            idle_timeout: std::time::Duration::from_secs(90),
            session_header: false,
            session_id: None,
            extra_headers: Vec::new(),
        };
        let completer = HttpCompleter { client: &client, resolved: &r };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let out = rt.block_on(completer.complete(vec![user("hi")], vec![])).unwrap();
        assert_eq!(out.text, "好的");
        assert!(out.tool_calls.is_empty());

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "应当只重发一次");
        assert!(seen[0].contains("393220"), "第一次发的是配置里的值：{}", seen[0]);
        assert!(seen[1].contains("393216"), "第二次必须换成上游给的上限：{}", seen[1]);
        assert!(!seen[1].contains("393220"), "旧值不该留在重发里：{}", seen[1]);
    }

    /// 报文里没有范围说明（opencode Go 实测偶尔只回模型名）时**不许猜**：
    /// 原样报错，且不产生第二次请求（那是一次白跑的计费调用）。
    #[test]
    fn http_completer_does_not_retry_an_unparseable_rejection() {
        use std::io::{Read, Write};
        use std::sync::{Arc, Mutex};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let sink = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                *sink.lock().unwrap() += 1;
                let mut buf = vec![0u8; 8192];
                let _ = Read::read(&mut s, &mut buf);
                let body = "{\"model\":\"deepseek-v4.1-flash\"}";
                let resp = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });

        let client = reqwest::Client::new();
        let r = Resolved {
            provider: "openai".into(),
            base_url: format!("http://{addr}/v1"),
            model: "m".into(),
            api_key: Some("sk-x".into()),
            max_tokens: Some(393220),
            temperature: Some(0.2),
            idle_timeout: std::time::Duration::from_secs(90),
            session_header: false,
            session_id: None,
            extra_headers: Vec::new(),
        };
        let completer = HttpCompleter { client: &client, resolved: &r };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let err = rt.block_on(completer.complete(vec![user("hi")], vec![])).unwrap_err();
        assert!(matches!(err, ChatError::Http { status: 400, .. }), "{err:?}");
        assert_eq!(*hits.lock().unwrap(), 1, "解析不出上限就不该重发");
    }
}
