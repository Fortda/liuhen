pub mod body;
pub mod browser;
pub mod focus;
pub mod ime;
pub mod input;
pub mod network;
pub mod win_map;
pub mod win_settings_mod;

use crate::module::ModuleRegistry;

/// 注册全部内置模组（含 stub）。宿主再决定 enable 哪些。
pub fn register_builtin_modules(reg: &mut ModuleRegistry) {
    reg.register(Box::new(input::InputModule::new()));
    reg.register(Box::new(focus::FocusModule::new()));
    reg.register(Box::new(win_map::WinMapModule::new()));
    reg.register(Box::new(win_settings_mod::WinSettingsModule::new()));
    reg.register(Box::new(body::BodyModule::new()));
    reg.register(Box::new(network::NetworkModule::new()));
    reg.register(Box::new(ime::ImeModule::new()));
    reg.register(Box::new(browser::BrowserModule::new()));
}
