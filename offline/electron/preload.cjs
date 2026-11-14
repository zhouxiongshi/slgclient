/**
 * 渲染层 ↔ 主进程的唯一受控通道。
 *
 * 背景：玩家反馈游戏窗口「一直压在最上层」，点不到其他应用、也点不到任务栏的
 * 最小化按钮。根因是主进程曾把窗口设成 screen-saver 级置顶。修复后
 * 默认永不置顶，这里只把「窗口行为」四个白名单方法暴露给设置面板，且全部走
 * invoke（参数只有布尔值），不暴露 ipcRenderer / fs / node / shell。
 *
 * 注意：不持久化置顶状态——每次启动一律回到「不置顶」，避免玩家上次误开后
 * 下次启动又被霸屏。设置面板里标注「仅本次运行有效」。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__slgWin', {
  isElectron: true,
  isAlwaysOnTop: () => ipcRenderer.invoke('win:is-always-on-top'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('win:always-on-top', !!on),
  minimize: () => ipcRenderer.invoke('win:minimize'),
});
