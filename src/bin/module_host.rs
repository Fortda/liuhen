//! 融合宿主 CLI（与默认 main 相同能力）。

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    omnitrace::bin_host::run_with_args(&args);
}
