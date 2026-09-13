//! 费用：LiteLLM 社区价表（牌价，不计促销/批量/priority）× usage 里的最终 token。
//! 不本地分词估 token。缓存读写按 usage 的 cache token × 对应单价；cached 已含在
//! prompt_tokens 时从输入里扣掉，避免重复计费。

use chrono::{SecondsFormat, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::notes_paths::pricing_config_path;

pub const LITELLM_PRICE_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
pub const LITELLM_PRICE_URL_FALLBACK: &str =
    "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json";
pub const PRICING_STALE_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceRates {
    pub input_per_1m: f64,
    pub output_per_1m: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_per_1m: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_per_1m: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_per_1m: Option<f64>,
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

fn default_currency() -> String {
    "USD".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PricingFile {
    pub v: u32,
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at_ms: Option<u64>,
    #[serde(default)]
    pub models: HashMap<String, PriceRates>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub overrides: HashMap<String, PriceRates>,
}

impl Default for PricingFile {
    fn default() -> Self {
        Self {
            v: 2,
            source: String::new(),
            source_url: None,
            fetched_at: None,
            fetched_at_ms: None,
            models: HashMap::new(),
            overrides: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub thinking_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CostBreakdown {
    pub input_usd: f64,
    pub output_usd: f64,
    pub cache_read_usd: f64,
    pub cache_write_usd: f64,
    pub thinking_usd: f64,
    pub total_usd: f64,
    pub currency: String,
    pub priced: bool,
    pub price_key: Option<String>,
}

fn pricing_mem() -> &'static Mutex<Option<PricingFile>> {
    static C: OnceLock<Mutex<Option<PricingFile>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn remember(p: &PricingFile) {
    if let Ok(mut g) = pricing_mem().lock() {
        *g = Some(p.clone());
    }
}

pub fn default_pricing_file() -> PricingFile {
    PricingFile {
        v: 2,
        source: "seed".into(),
        source_url: None,
        fetched_at: None,
        fetched_at_ms: None,
        models: HashMap::new(),
        overrides: HashMap::new(),
    }
}

pub fn load_pricing() -> PricingFile {
    if let Ok(g) = pricing_mem().lock() {
        if let Some(p) = g.as_ref() {
            return p.clone();
        }
    }
    let path = pricing_config_path();
    if path.is_file() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(p) = serde_json::from_str::<PricingFile>(&raw) {
                remember(&p);
                return p;
            }
        }
    }
    let def = default_pricing_file();
    let _ = save_pricing(&def);
    def
}

pub fn save_pricing(p: &PricingFile) -> Result<(), String> {
    let path = pricing_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    remember(p);
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn pricing_is_stale(p: &PricingFile, max_age_ms: u64) -> bool {
    if p.source != "litellm_community" || p.models.is_empty() {
        return true;
    }
    let Some(ts) = p.fetched_at_ms else {
        return true;
    };
    now_ms().saturating_sub(ts) > max_age_ms
}

fn json_f64(v: &Value, key: &str) -> Option<f64> {
    let x = v.get(key)?;
    x.as_f64()
        .or_else(|| x.as_u64().map(|n| n as f64))
        .or_else(|| x.as_i64().map(|n| n as f64))
}

fn json_u64(v: &Value, key: &str) -> Option<u64> {
    let x = v.get(key)?;
    x.as_u64()
        .or_else(|| x.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| x.as_f64().map(|n| n as u64))
}

fn per_token_to_1m(per_token: f64) -> f64 {
    let v = per_token * 1_000_000.0;
    (v * 1_000_000.0).round() / 1_000_000.0
}

fn is_text_mode(mode: Option<&str>) -> bool {
    matches!(mode, Some("chat") | Some("completion") | Some("responses") | None)
}

/// 把 LiteLLM 社区 JSON 收成「每百万 token 牌价」。跳过促销/批量/priority/`above_*` 档。
pub fn convert_community_map(raw: &Value, fetched_at: &str) -> HashMap<String, PriceRates> {
    let obj = match raw.as_object() {
        Some(o) => o,
        None => return HashMap::new(),
    };
    let mut models = HashMap::new();
    for (key, spec) in obj {
        if key == "sample_spec" || !spec.is_object() {
            continue;
        }
        let mode = spec.get("mode").and_then(|v| v.as_str());
        if !is_text_mode(mode) {
            continue;
        }
        let Some(input) = json_f64(spec, "input_cost_per_token") else {
            continue;
        };
        let output = json_f64(spec, "output_cost_per_token").unwrap_or(0.0);
        let provider = spec
            .get("litellm_provider")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let rates = PriceRates {
            input_per_1m: per_token_to_1m(input),
            output_per_1m: per_token_to_1m(output),
            cache_read_per_1m: json_f64(spec, "cache_read_input_token_cost").map(per_token_to_1m),
            cache_write_per_1m: json_f64(spec, "cache_creation_input_token_cost")
                .map(per_token_to_1m),
            thinking_per_1m: json_f64(spec, "output_cost_per_reasoning_token").map(per_token_to_1m),
            currency: "USD".into(),
            doc_url: spec
                .get("source")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            updated_at: Some(fetched_at.to_string()),
            max_input_tokens: json_u64(spec, "max_input_tokens")
                .or_else(|| json_u64(spec, "max_tokens")),
            max_output_tokens: json_u64(spec, "max_output_tokens"),
        };
        insert_alias(&mut models, key.clone(), rates.clone());
        if !key.contains('/') && !provider.is_empty() {
            insert_alias(&mut models, format!("{provider}/{key}"), rates.clone());
        }
        if provider == "gemini" {
            let bare = key.rsplit('/').next().unwrap_or(key);
            insert_alias(&mut models, format!("google/{bare}"), rates);
        }
    }
    models
}

fn insert_alias(map: &mut HashMap<String, PriceRates>, key: String, rates: PriceRates) {
    map.entry(key).or_insert(rates);
}

async fn fetch_json(url: &str) -> Result<Value, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(40))
        .user_agent("omnitrace-notes/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

pub async fn fetch_community_pricing(
    overrides: HashMap<String, PriceRates>,
) -> Result<PricingFile, String> {
    let raw = match fetch_json(LITELLM_PRICE_URL).await {
        Ok(v) => v,
        Err(e1) => match fetch_json(LITELLM_PRICE_URL_FALLBACK).await {
            Ok(v) => v,
            Err(e2) => {
                return Err(format!("拉取 LiteLLM 社区价表失败：{e1}；备用源：{e2}"));
            }
        },
    };
    let fetched_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let models = convert_community_map(&raw, &fetched_at);
    if models.len() < 50 {
        return Err(format!(
            "社区价表条目过少（{}），可能不是完整 model_prices JSON",
            models.len()
        ));
    }
    Ok(PricingFile {
        v: 2,
        source: "litellm_community".into(),
        source_url: Some(LITELLM_PRICE_URL.into()),
        fetched_at: Some(fetched_at),
        fetched_at_ms: Some(now_ms()),
        models,
        overrides,
    })
}

pub async fn refresh_pricing_if_stale(max_age_ms: u64) -> Result<PricingFile, String> {
    let current = load_pricing();
    if !pricing_is_stale(&current, max_age_ms) {
        return Ok(current);
    }
    match fetch_community_pricing(current.overrides.clone()).await {
        Ok(fresh) => {
            save_pricing(&fresh)?;
            Ok(fresh)
        }
        Err(e) => {
            if !current.models.is_empty() {
                Ok(current)
            } else {
                Err(e)
            }
        }
    }
}

fn per_m(tokens: u64, rate: f64) -> f64 {
    (tokens as f64 / 1_000_000.0) * rate
}

fn last_seg(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

fn get_rate<'a>(p: &'a PricingFile, key: &str) -> Option<&'a PriceRates> {
    p.overrides.get(key).or_else(|| p.models.get(key))
}

pub fn lookup_rates<'a>(
    pricing: &'a PricingFile,
    model_key: &str,
    litellm_model: &str,
) -> Option<(String, &'a PriceRates)> {
    let candidates = [
        litellm_model,
        model_key,
        last_seg(litellm_model),
        last_seg(model_key),
    ];
    for k in candidates {
        if k.is_empty() {
            continue;
        }
        if let Some(r) = get_rate(pricing, k) {
            return Some((k.to_string(), r));
        }
    }
    let needle = last_seg(litellm_model);
    if needle.is_empty() {
        return None;
    }
    let suffix = format!("/{needle}");
    for (k, r) in pricing.overrides.iter().chain(pricing.models.iter()) {
        if k == needle || k.ends_with(&suffix) {
            return Some((k.clone(), r));
        }
    }
    None
}

pub fn compute_cost(model_key: &str, litellm_model: &str, usage: &TokenUsage) -> CostBreakdown {
    compute_cost_with(&load_pricing(), model_key, litellm_model, usage)
}

pub fn compute_cost_with(
    pricing: &PricingFile,
    model_key: &str,
    litellm_model: &str,
    usage: &TokenUsage,
) -> CostBreakdown {
    let Some((hit_key, r)) = lookup_rates(pricing, model_key, litellm_model) else {
        return CostBreakdown {
            currency: "USD".into(),
            priced: false,
            price_key: None,
            ..Default::default()
        };
    };
    let prompt = usage.input_tokens.unwrap_or(0);
    let cached = usage.cache_read_tokens.unwrap_or(0);
    let created = usage.cache_creation_tokens.unwrap_or(0);
    let output = usage.output_tokens.unwrap_or(0);
    let think = usage.thinking_tokens.unwrap_or(0);
    // prompt_tokens 一般已含 cache read/write；牌价按「未缓存输入 + 缓存读写」。
    let billed_input = prompt.saturating_sub(cached).saturating_sub(created);
    let input_usd = per_m(billed_input, r.input_per_1m);
    let cache_read_usd = per_m(cached, r.cache_read_per_1m.unwrap_or(0.0));
    let cache_write_usd = per_m(created, r.cache_write_per_1m.unwrap_or(0.0));
    let (output_usd, thinking_usd) = if let Some(tr) = r.thinking_per_1m {
        if think > 0 {
            (
                per_m(output.saturating_sub(think), r.output_per_1m),
                per_m(think, tr),
            )
        } else {
            (per_m(output, r.output_per_1m), 0.0)
        }
    } else {
        (per_m(output, r.output_per_1m), 0.0)
    };
    let total_usd = input_usd + output_usd + cache_read_usd + cache_write_usd + thinking_usd;
    CostBreakdown {
        input_usd,
        output_usd,
        cache_read_usd,
        cache_write_usd,
        thinking_usd,
        total_usd,
        currency: r.currency.clone(),
        priced: true,
        price_key: Some(hit_key),
    }
}

fn u64_path(u: &Value, keys: &[&str]) -> Option<u64> {
    let mut cur = u;
    for k in keys {
        cur = cur.get(*k)?;
    }
    cur.as_u64()
        .or_else(|| cur.as_i64().and_then(|n| u64::try_from(n).ok()))
}

pub fn usage_from_openai_json(u: &Value) -> TokenUsage {
    let cache_read = u64_path(u, &["prompt_tokens_details", "cached_tokens"])
        .or_else(|| u64_path(u, &["cache_read_input_tokens"]))
        .or_else(|| u64_path(u, &["prompt_cache_hit_tokens"]));
    let cache_creation = u64_path(u, &["cache_creation_input_tokens"])
        .or_else(|| u64_path(u, &["prompt_tokens_details", "cache_write_tokens"]))
        .or_else(|| u64_path(u, &["prompt_cache_miss_tokens"]));
    TokenUsage {
        input_tokens: u64_path(u, &["prompt_tokens"]),
        output_tokens: u64_path(u, &["completion_tokens"]),
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_creation,
        thinking_tokens: u64_path(u, &["completion_tokens_details", "reasoning_tokens"])
            .or_else(|| u64_path(u, &["reasoning_tokens"])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn convert_gpt4o_list_price() {
        let raw = json!({
            "sample_spec": { "mode": "chat" },
            "gpt-4o": {
                "input_cost_per_token": 2.5e-6,
                "output_cost_per_token": 1e-5,
                "cache_read_input_token_cost": 1.25e-6,
                "input_cost_per_token_batches": 1.25e-6,
                "litellm_provider": "openai",
                "max_input_tokens": 128000,
                "mode": "chat",
                "source": "https://openai.com/api/pricing/"
            }
        });
        let map = convert_community_map(&raw, "2026-08-26");
        let r = map.get("gpt-4o").expect("bare");
        assert!((r.input_per_1m - 2.5).abs() < 1e-9);
        assert!((r.output_per_1m - 10.0).abs() < 1e-9);
        assert!((r.cache_read_per_1m.unwrap() - 1.25).abs() < 1e-9);
        assert!(map.get("openai/gpt-4o").is_some());
        assert_eq!(r.max_input_tokens, Some(128000));
    }

    #[test]
    fn cost_subtracts_cached_from_input() {
        let mut models = HashMap::new();
        models.insert(
            "openai/gpt-4o".into(),
            PriceRates {
                input_per_1m: 2.5,
                output_per_1m: 10.0,
                cache_read_per_1m: Some(1.25),
                cache_write_per_1m: None,
                thinking_per_1m: None,
                currency: "USD".into(),
                doc_url: None,
                updated_at: None,
                max_input_tokens: None,
                max_output_tokens: None,
            },
        );
        let file = PricingFile {
            v: 2,
            source: "litellm_community".into(),
            source_url: None,
            fetched_at: None,
            fetched_at_ms: Some(now_ms()),
            models,
            overrides: HashMap::new(),
        };
        let usage = TokenUsage {
            input_tokens: Some(1000),
            cache_read_tokens: Some(400),
            cache_creation_tokens: None,
            thinking_tokens: None,
            output_tokens: Some(200),
        };
        let c = compute_cost_with(&file, "x/gpt-4o", "openai/gpt-4o", &usage);
        // 600 uncached * 2.5/1M + 400 cache * 1.25/1M + 200 * 10/1M
        let expect = 600.0 / 1e6 * 2.5 + 400.0 / 1e6 * 1.25 + 200.0 / 1e6 * 10.0;
        assert!((c.total_usd - expect).abs() < 1e-12);
        assert!(c.priced);
    }

    #[test]
    fn thinking_not_double_counted_when_no_separate_rate() {
        let mut models = HashMap::new();
        models.insert(
            "m".into(),
            PriceRates {
                input_per_1m: 1.0,
                output_per_1m: 2.0,
                cache_read_per_1m: None,
                cache_write_per_1m: None,
                thinking_per_1m: None,
                currency: "USD".into(),
                doc_url: None,
                updated_at: None,
                max_input_tokens: None,
                max_output_tokens: None,
            },
        );
        let file = PricingFile {
            v: 2,
            source: "t".into(),
            source_url: None,
            fetched_at: None,
            fetched_at_ms: None,
            models,
            overrides: HashMap::new(),
        };
        let usage = TokenUsage {
            input_tokens: Some(0),
            output_tokens: Some(100),
            thinking_tokens: Some(40),
            cache_read_tokens: None,
            cache_creation_tokens: None,
        };
        let c = compute_cost_with(&file, "m", "m", &usage);
        assert!((c.output_usd - per_m(100, 2.0)).abs() < 1e-12);
        assert_eq!(c.thinking_usd, 0.0);
    }
}
