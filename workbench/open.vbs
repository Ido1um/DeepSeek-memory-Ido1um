' 记忆工作台 · 无窗口启动器
' 由「记忆工作台.lnk」调用：起服务（若没起）+ 开浏览器，不弹控制台。
Option Explicit
Dim sh, node, script
Set sh = CreateObject("WScript.Shell")
node = "\tools\node-runtime\bin\node.exe"
script = "\workbench\open.mjs"
sh.Run """" & node & """ """ & script & """", 0, False
