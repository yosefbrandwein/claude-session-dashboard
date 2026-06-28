' Launches run-agent.cmd with NO visible console window (0 = hidden), so the
' "at logon" Scheduled Task keeps the device agent alive in the background.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\run-agent.cmd""", 0, False
