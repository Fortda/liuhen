# OmniTrace Android

自用边载采集 APK。契约见仓库 [`docs/architecture/OVERVIEW.md`](../docs/architecture/OVERVIEW.md) §8 与 [`docs/architecture/android.md`](../docs/architecture/android.md)。

本期 **不进 Windows OmniPlayer**。不录麦克风 PCM、不录相机预览。

App 底栏三页：**设置**（分组卡片：采集、开机自启/后台常驻、外观、权限、数据；地图资源另页）、**播放器**（选日回放地图+时间轴）、**仪表盘**（全屏时间轴/行踪等）。底图可选 CARTO/OSM（WGS84）或高德（GCJ-02）；放大未下载的城会先问体积。

## 做什么

单 APK、进程内模组、通知栏前台服务。无障碍与采集同一进程。本机写入 App 外部目录下的 `OmniDatabase/`（Century/Year/Month + ModuleEvent JSONL + `imu_DD.bin`）。

模组：`hw` `device` `imu` `env` `gps` `perf` `radio` `media` `app_focus` `touch` `ui_map`。

启动扫硬件身份；签名不变只写一行 `hw_unchanged`（组件信息无变化）。

## 怎么编

1. 安装 [Android Studio](https://developer.android.com/studio)（本仓库开发机未必有 SDK）。
2. 用 JDK 17+（例如 `C:\Program Files\Microsoft\jdk-21.0.7.6-hotspot`）。
3. `File → Open` 选本目录 `omnitrace_android/`。Gradle JVM 选 **21**（不要 25）。路径里有中文时 AGP 会报 non-ASCII，已在 `gradle.properties` 里关检查；若仍编不过，把仓库拷到纯英文路径再开。
4. 复制 `local.properties.example` 为 `local.properties`，填 `sdk.dir=`。
5. 连手机，边载 Debug APK。不要上架。

国产 ROM：设置里打开 **忽略电池优化**、自启动白名单，否则前台服务仍会被杀。

## 权限

设置页清单：位置（灭屏 GPS 还要后台位置）、通知、计步、无障碍、电池优化。无障碍用于焦点/点击目标/窗栈，**不开触摸探索**。

## 导出到电脑（旁路根）

App 内「导出到所选文件夹」会写成 `sources/<android_id>/`。

或 USB：

```text
adb pull /sdcard/Android/data/com.omnitrace.android/files/OmniDatabase ./OmniDatabase/sources/<android_id>
```

实际路径以设置页可复制文本为准。不要把文件合并进 Windows 的 `EventData/.../trace_DD.bin`。

## IMU bin（`OTIM` v1）

大端。文件头 16 字节：`OTIM` + ver=1。`0xFF` 绝对样本（ts + 通道 + i16 xyz）；`1..250` 为相对 dt。通道 1 加速度 / 2 线性加速度 / 3 陀螺 / 4 磁力。禁止写入 `trace_DD.bin`。
