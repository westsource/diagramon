//! AI 相关命令：模型配置、密钥（走平台凭据库）、生成/识图/回修、对话持久化。

use app_core::ConversationStore;
use app_ipc::{AiChatMessage, AiModelConfig, AiSettings, AiStateSnapshot, ApiError, DocFormat};
use ai::{AiError, ModelConfig, Provider};
use tauri::State;

use crate::state::AppState;

type Res<T> = Result<T, ApiError>;

/// 凭据库里每个模型 API Key 的逻辑键前缀。
const KEY_PREFIX: &str = "ai.";

fn key_for(model_id: &str) -> String {
    format!("{KEY_PREFIX}{model_id}")
}

fn ai_err(e: AiError) -> ApiError {
    ApiError::new(e.code(), e.to_string())
}

fn config_err(msg: impl Into<String>) -> ApiError {
    ApiError::new("ai_config", msg)
}

/// 当前 AI 状态快照。
#[tauri::command]
pub fn ai_state(state: State<'_, AppState>) -> AiStateSnapshot {
    let (models, selected, retry, vision, storage) = state.with_settings(|s| {
        (
            s.ai.models.clone(),
            s.ai.selected_model_id.clone(),
            s.ai.render_feedback_retry,
            s.ai.vision_notice_accepted,
            s.ai.conversation_storage_path.clone(),
        )
    });

    let credentials = state.platform().credentials();
    let models_with_key = models
        .iter()
        .filter(|m| {
            credentials
                .get(&key_for(&m.id))
                .ok()
                .flatten()
                .is_some_and(|k| !k.trim().is_empty())
        })
        .map(|m| m.id.clone())
        .collect();

    AiStateSnapshot {
        models,
        selected_model_id: selected,
        models_with_key,
        render_feedback_retry: retry,
        vision_notice_accepted: vision,
        conversation_storage_path: storage,
    }
}

/// 覆盖写 AI 设置（模型列表/选中/开关）并落盘。
#[tauri::command]
pub fn ai_settings_save(state: State<'_, AppState>, ai: AiSettings) -> AiStateSnapshot {
    state.with_settings(|s| s.ai = ai);
    state.persist_settings();
    ai_state(state)
}

/// 写入某模型的 API Key（经平台凭据库，密文落盘）。
#[tauri::command]
pub fn ai_key_set(state: State<'_, AppState>, model_id: String, key: String) -> Res<AiStateSnapshot> {
    state
        .platform()
        .credentials()
        .set(&key_for(&model_id), &key)
        .map_err(|e| ApiError::new("credential", e.to_string()))?;
    Ok(ai_state(state))
}

/// 删除某模型的 API Key。
#[tauri::command]
pub fn ai_key_delete(state: State<'_, AppState>, model_id: String) -> Res<AiStateSnapshot> {
    state
        .platform()
        .credentials()
        .delete(&key_for(&model_id))
        .map_err(|e| ApiError::new("credential", e.to_string()))?;
    Ok(ai_state(state))
}

fn lookup(state: &State<'_, AppState>, model_id: &str) -> Res<(ModelConfig, Option<String>)> {
    let config = state
        .with_settings(|s| s.ai.models.iter().find(|m| m.id == model_id).cloned())
        .ok_or_else(|| config_err(format!("找不到模型配置: {model_id}")))?;

    let api_key = state
        .platform()
        .credentials()
        .get(&key_for(model_id))
        .map_err(|e| ApiError::new("credential", e.to_string()))?;

    if config.provider.requires_key() && api_key.as_deref().is_none_or(|k| k.trim().is_empty()) {
        return Err(config_err("该模型尚未配置 API Key"));
    }

    Ok((config, api_key))
}

/// 一句话生成/修改代码。返回提取后的代码。
#[tauri::command]
pub async fn ai_generate(
    state: State<'_, AppState>,
    model_id: String,
    format: DocFormat,
    current_code: String,
    instruction: String,
    history: Vec<AiChatMessage>,
) -> Res<String> {
    if !ai::prompt::supports_ai(format) {
        return Err(config_err("该格式不支持 AI 生成"));
    }
    let (config, key) = lookup(&state, &model_id)?;
    let messages = ai::prompt::build_messages(format, &current_code, &history, &instruction);
    let reply = ai::chat(&state.http, &config, key.as_deref(), &messages)
        .await
        .map_err(ai_err)?;
    Ok(ai::prompt::extract_code(&reply))
}

/// 识图：截图 → 代码。
#[tauri::command]
pub async fn ai_generate_from_image(
    state: State<'_, AppState>,
    model_id: String,
    format: DocFormat,
    image_data_url: String,
    history: Vec<AiChatMessage>,
) -> Res<String> {
    if !ai::prompt::supports_ai(format) {
        return Err(config_err("该格式不支持识图"));
    }
    let (config, key) = lookup(&state, &model_id)?;
    let messages = ai::prompt::build_vision_messages(format, &history, &image_data_url);
    let reply = ai::chat(&state.http, &config, key.as_deref(), &messages)
        .await
        .map_err(ai_err)?;
    Ok(ai::prompt::extract_code(&reply))
}

/// 渲染失败后的自动回修。
#[tauri::command]
pub async fn ai_repair(
    state: State<'_, AppState>,
    model_id: String,
    format: DocFormat,
    code: String,
    error_text: String,
) -> Res<String> {
    let (config, key) = lookup(&state, &model_id)?;
    let messages = ai::prompt::build_repair_messages(format, &code, &error_text);
    let reply = ai::chat(&state.http, &config, key.as_deref(), &messages)
        .await
        .map_err(ai_err)?;
    Ok(ai::prompt::extract_code(&reply))
}

/// 解析对话存储目录（设置优先，其次应用数据目录下的 `Conversations`）。
fn conversation_dir(state: &State<'_, AppState>) -> std::path::PathBuf {
    state
        .with_settings(|s| s.ai.conversation_storage_path.clone())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| state.platform().paths().data_dir().join("Conversations"))
}

/// 文档路径 → 稳定身份键（前端也可自己算，这里保持单一真源）。
#[tauri::command]
pub fn ai_conversation_key(path: String) -> String {
    app_core::identity_key(&path)
}

/// 读取某文档的对话。
#[tauri::command]
pub fn ai_conversation_load(state: State<'_, AppState>, key: String) -> Vec<AiChatMessage> {
    ConversationStore::new(conversation_dir(&state)).load(&key)
}

/// 写入某文档的对话。
#[tauri::command]
pub fn ai_conversation_save(
    state: State<'_, AppState>,
    key: String,
    messages: Vec<AiChatMessage>,
) -> Res<()> {
    ConversationStore::new(conversation_dir(&state))
        .save(&key, &messages)
        .map(|_| ())
        .map_err(|e| ApiError::new("io", format!("对话保存失败: {e}")))
}

/// 清空某文档的对话。
#[tauri::command]
pub fn ai_conversation_clear(state: State<'_, AppState>, key: String) -> Res<()> {
    ConversationStore::new(conversation_dir(&state))
        .clear(&key)
        .map_err(|e| ApiError::new("io", format!("对话清空失败: {e}")))
}

/// 供诊断：默认的供应商基地址（前端"新建模型"的初值）。
#[tauri::command]
pub fn ai_default_base_url(provider: Provider) -> String {
    provider.default_base_url().to_string()
}

/// 校验一个模型配置是否自洽（前端保存前调用，给出可读原因）。
#[tauri::command]
pub fn ai_validate_model(model: AiModelConfig) -> Res<()> {
    if model.id.trim().is_empty() {
        return Err(config_err("模型 id 不能为空"));
    }
    if model.model_id.trim().is_empty() {
        return Err(config_err("模型名称（model id）不能为空"));
    }
    if ai::effective_base_url(&model).trim().is_empty() {
        return Err(config_err("Base URL 不能为空"));
    }
    Ok(())
}

/// 便于前端展示：清洗后的基地址与实际端点。
#[tauri::command]
pub fn ai_endpoints(model: AiModelConfig) -> (String, String) {
    (ai::effective_base_url(&model), ai::endpoint(&model))
}
