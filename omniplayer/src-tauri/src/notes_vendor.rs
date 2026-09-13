//! 笔记 LLM 服务商预设：UI 展示名与 LiteLLM 内部前缀分离。

#[derive(Debug, Clone, Copy)]
pub struct VendorPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub api_base: &'static str,
    /// LiteLLM 路由前缀（Google UI 为 google，内部为 gemini）
    pub litellm_prefix: &'static str,
}

pub const VENDORS: &[VendorPreset] = &[
    VendorPreset {
        id: "openai",
        label: "OpenAI",
        api_base: "https://api.openai.com/v1",
        litellm_prefix: "openai",
    },
    VendorPreset {
        id: "anthropic",
        label: "Anthropic",
        api_base: "https://api.anthropic.com",
        litellm_prefix: "anthropic",
    },
    VendorPreset {
        id: "google",
        label: "Google",
        api_base: "https://generativelanguage.googleapis.com/v1beta",
        litellm_prefix: "gemini",
    },
    VendorPreset {
        id: "deepseek",
        label: "DeepSeek",
        api_base: "https://api.deepseek.com",
        litellm_prefix: "deepseek",
    },
    // OpenAI 兼容中转（One API / New API 等）：用对方的 Base + Key，协议当 openai。
    VendorPreset {
        id: "relay",
        label: "中转",
        api_base: "",
        litellm_prefix: "openai",
    },
];

pub fn normalize_vendor(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "gemini" => "google".into(),
        "proxy" | "zhongzhuan" | "中转" | "openai-compatible" | "openai_compat" => {
            "relay".into()
        }
        other if VENDORS.iter().any(|v| v.id == other) => other.into(),
        _ => {
            if raw.is_empty() {
                "openai".into()
            } else {
                raw.to_string()
            }
        }
    }
}

pub fn vendor_preset(vendor: &str) -> Option<&'static VendorPreset> {
    let v = normalize_vendor(vendor);
    VENDORS.iter().find(|p| p.id == v)
}

pub fn litellm_prefix(vendor: &str) -> String {
    vendor_preset(vendor)
        .map(|p| p.litellm_prefix.to_string())
        .unwrap_or_else(|| normalize_vendor(vendor))
}

pub fn default_label(vendor: &str) -> String {
    vendor_preset(vendor)
        .map(|p| p.label.to_string())
        .unwrap_or_else(|| vendor.to_string())
}

pub fn default_api_base(vendor: &str) -> String {
    vendor_preset(vendor)
        .map(|p| p.api_base.to_string())
        .unwrap_or_default()
}

pub fn new_provider_id(vendor: &str) -> String {
    let v = normalize_vendor(vendor);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("prov_{v}_{ts}")
}
