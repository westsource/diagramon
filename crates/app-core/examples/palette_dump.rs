//! 把色系注册表原样吐出来：`cargo run -p app-core --example palette_dump`。
//!
//! 为什么会留一个 example 而不是测试里 print：色值是**设计产物**，改完要拿给人看、
//! 也要同步到 `design/ui-proto/palette-proto.html` 里那张表。从 `infos()` 直接导出
//! 是唯一不会和实现漂开的来源（原型里手抄一份 hex 就是"两处实现"）。
//!
//! 输出是 `{ id: { zh, en, edge: { light, dark }, roles: { <role>: { light|dark: { fill, stroke, text } } } } }`。
use std::collections::BTreeMap;

use app_core::palette;
use serde_json::json;

fn main() {
    let mut out = BTreeMap::new();
    for p in palette::infos() {
        let mut roles = serde_json::Map::new();
        for r in &p.roles {
            roles.insert(
                r.role.clone(),
                json!({
                    "light": { "fill": r.light.fill, "stroke": r.light.stroke, "text": r.light.text },
                    "dark": { "fill": r.dark.fill, "stroke": r.dark.stroke, "text": r.dark.text },
                }),
            );
        }
        out.insert(
            p.id.clone(),
            json!({
                "zh": p.name_zh,
                "en": p.name_en,
                "edge": { "light": p.edge_light, "dark": p.edge_dark },
                "roles": roles,
            }),
        );
    }
    println!("{}", serde_json::to_string_pretty(&out).expect("序列化色系表"));
}
