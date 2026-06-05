# Encrypted Audio MP3 Converter

加密音频格式转换为MP3的工具。

## 功能

- 支持将加密音频格式（现在支持KGM/KGMA/NCM/KWM/MGG/MGG0/MGG1/MGGL/MFLAC/MFLAC0）转换为MP3
- 支持批量转换
- 提供Web界面操作
- 跨平台支持

## 技术栈

- Node.js
- 前端：HTML/CSS/JavaScript

## 目录结构

```
app/
  public/           - 前端资源（HTML/CSS/JS）
    index.html      - 主页
    styles.css      - 样式文件
    app.js          - 前端逻辑
  server.js         - 服务器端
convert-kgm-to-mp3.js    - KGM转MP3转换器
convert-batch-worker.js  - 批量转换工作进程
mp3-output/         - MP3输出目录
```

## 启动方式

双击 `启动KGM转换器.ps1` 自动启动

## 注意事项
请自行确认文件来源、版权归属和使用边界。 本项目不储存、复制、传播任何文件，不做任何盈利，仅作个人公益学习，请勿非法&商业传播。
