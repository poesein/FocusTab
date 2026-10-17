# FocusTab · 专注

此 fork 的开发入口是 **[focus-tab/](focus-tab/README.md)**：中文新标签页、页面任务相关性判断、浏览器原生规则拦截。它是一个独立构建的 Chrome / Edge 扩展，无需 ActivityWatch 或桌面记录服务，使用单独的 Manifest 和依赖。源码和构建工作流见 [poesein/FocusTab](https://github.com/poesein/FocusTab)。

在 `focus-tab` 中运行 `npm ci && npm test && npm run build`，然后在浏览器开发人员模式中加载生成的 `focus-tab/dist`。安装说明、权限与数据流、AI 配置和局限见该目录的中文 README。

以下保留原作者 LeechBlock NG 的介绍与许可背景；原版目录不作为 FocusTab 的运行入口。

---

# LeechBlock NG for Chrome

[![Awesome Humane Tech](https://raw.githubusercontent.com/humanetech-community/awesome-humane-tech/main/humane-tech-badge.svg?sanitize=true)](https://github.com/humanetech-community/awesome-humane-tech)

LeechBlock NG (Next Generation) is a simple productivity tool designed to block those time-wasting sites that can suck the life out of your working day. All you need to do is specify which sites to block and when to block them.

**Author:** James Anderson

**Contributors:** Dario Kolac (graphics) & Robert Gützkow (graphics)

Note that the latest version of [jQuery UI](https://jqueryui.com/) should be installed in the subfolder `jquery-ui`.

**Policy on PRs:** I'm happy to consider PRs, but unless they're relatively simple (e.g., bug fixes or UI tweaks) it will take me some time to review and test them, and even then I may decide not to approve them. Please understand that LeechBlock is just a hobby for me, and I have very little time even to develop my own code, never mind other people's code! If you want to fork LeechBlock and release your own version, you're more than welcome.
