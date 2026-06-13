<div align="center">

# TikTok Live Spy

**实时捕捉 TikTok 直播间的弹幕、礼物与互动数据 · Real-time capture of TikTok LIVE chat, gifts & engagement**

[English](README.md) · [**中文**](README.zh-CN.md)

<img src="docs/screenshot.png" alt="TikTok Live Spy 截图" width="100%">

</div>

---

## 项目简介

**TikTok Live Spy** 可以连接任意公开的 TikTok 直播间,把直播间的实时事件 —— 弹幕评论、
礼物、点赞、关注、分享、进场 —— 全部推送到一个简洁的网页看板上。它面向**直播互动数据的
监控与分析**场景,并被设计成一个**独立、自包含、可自由二次开发**的代码库。

底层它把 [@zerodytrash](https://github.com/zerodytrash) 的两个开源项目合并到了一起:
直播连接库 **[TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector)**
(以本地源码的形式内置,方便你修改和重新构建)和网页应用
**[TikTok-Chat-Reader](https://github.com/zerodytrash/TikTok-Chat-Reader)**,并适配了最新的
连接库(v2.x),修复了代理、事件序列化、字段映射等问题,开箱即用、端到端打通。

## 功能特性

- 🔴 **实时事件流** —— 弹幕、礼物、点赞、关注、分享、进场,全部实时显示
- 📊 **直播间统计** —— 在线观众数、累计点赞数、收到的钻石数
- 🎁 **礼物详情** —— 礼物名称、钻石价值、图标(通过直播间礼物列表补全)
- 🧱 **可编辑的连接库** —— 连接库以 npm workspace 形式放在 `connector/`,可直接改源码
- 🌐 **代理支持** —— 需要时可让所有 TikTok 流量走你自己的代理
- 🖥️ **OBS 叠加层** —— 提供透明背景页面,可作为 OBS 浏览器源

## 项目结构

```
tiktok_live_spy/
├── server.js              # Express + Socket.IO 后端
├── connectionWrapper.js   # 连接库的重连 / 错误处理封装
├── limiter.js             # 按 IP 限流
├── public/                # 前端 (index.html, app.js, connection.js, obs.html, style.css)
├── connector/             # 内置的 TikTok-Live-Connector 连接库 (npm workspace)
│   └── src/               # 在这里改连接库,改完执行 `npm run build:connector`
├── docs/                  # 截图与素材
├── .env.example           # 复制为 .env 并填入你自己的配置
└── package.json           # 根应用 + workspace 配置
```

## 环境要求

- [Node.js](https://nodejs.org/) >= 20

## 快速开始

```bash
# 1. 安装依赖(同时会自动构建内置的连接库)
npm install

# 2. 从模板创建本地配置
cp .env.example .env
#    然后打开 .env 填入配置项(见下方"配置说明")

# 3. 启动服务
npm start
```

打开 <http://localhost:8081> ,输入一个**正在直播**的用户 **@用户名**即可。

## 配置说明

所有配置都放在 `.env` 中(该文件已被 **git 忽略**,切勿提交)。请复制 `.env.example`
并填入你自己的值:

| 变量 | 是否必填 | 说明 |
|------|----------|------|
| `PORT` | 否 | 网页服务端口(默认 `8081`) |
| `API_KEY` | 推荐 | 你自己的 [Euler Stream](https://www.eulerstream.com/) API Key,用于请求签名以提升连接稳定性。可在其官网免费申请。 |
| `PROXY` | 视情况 | 所有 TikTok 流量走的代理地址(如 `http://127.0.0.1:7897`)。如果你的网络无法直连 TikTok 则必填。 |
| `SESSIONID` | 否 | TikTok 的 `sessionid` Cookie,用于需要登录的直播间 |
| `ENABLE_RATE_LIMIT` | 否 | 设为任意非空值即可开启按 IP 限流 |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY` | 否 | Google reCAPTCHA v2 密钥,用于限制连接 |

> **请妥善保管你的密钥。** `API_KEY`、`SESSIONID`、reCAPTCHA 密钥都是你的个人凭据 ——
> 只保存在本地 `.env` 中,绝不要提交到代码仓库。

## 开发

| 命令 | 说明 |
|------|------|
| `npm start` | 启动服务 |
| `npm run dev` | 以 `--watch` 启动(文件变更自动重启) |
| `npm run build:connector` | 修改 `connector/src` 后重新构建连接库 |

`/obs.html` 页面提供透明背景版本,可直接作为 OBS 浏览器源使用。

## 工作原理

```
浏览器  ⇄  Socket.IO  ⇄  server.js  ⇄  连接库(代理)  ⇄  TikTok 直播
```

后端通过连接库连上 TikTok 直播间(可选地走你的代理与 Euler Stream 签名),对每条事件做
归一化和清洗后,通过 Socket.IO 转发给浏览器,由前端渲染展示。

## 注意事项与限制

- TikTok 的非官方 API 可能会对服务器 IP 限流或封禁。配置 Euler Stream 的 `API_KEY`
  可以让连接稳定得多。
- TikTok 现在大多数直播事件里**不再下发用户头像**,所以弹幕头像可能默认是空的(属正常)。
  礼物/头像图片是浏览器直接从 TikTok CDN 加载的,在该 CDN 被屏蔽的网络下可能无法显示。
- 本项目基于非官方的逆向 API,仅用于学习与数据分析用途。

## 致谢

两个上游项目均由 [@zerodytrash](https://github.com/zerodytrash) 开发,采用 MIT 协议。
本仓库在其基础上合并并适配而来。

## 许可证

MIT
