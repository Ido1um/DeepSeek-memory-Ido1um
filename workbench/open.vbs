' 记忆工作台 · 无窗口启动器
' 起服务（若没起）+ 开浏览器，不弹控制台。需要 PATH 里有 node。
Option Explicit
Dim sh, fso, here, script
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
script = here & "\open.mjs"
sh.Run "node """ & script & """", 0, False
