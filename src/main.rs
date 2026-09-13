//! 兼容入口：直接进「融合宿主」（键鼠+焦点+窗口图等同进程）。

fn main() {
    omnitrace::bin_host::run_default();
}
