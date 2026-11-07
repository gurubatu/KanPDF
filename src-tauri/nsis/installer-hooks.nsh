; 修复旧版安装残留：注册表在但 uninstall.exe 已丢失时，安装/卸载会失败
!include LogicLib.nsh

!macro _StripRegQuotes Var
  StrLen $R8 "${Var}"
  ${If} $R8 > 1
    StrCpy $R7 "${Var}" 1 0
    IntOp $R8 $R8 - 1
    StrCpy $R6 "${Var}" 1 $R8
    ${If} $R7 == '"'
    ${AndIf} $R6 == '"'
      StrCpy ${Var} "${Var}" -1 1
      StrLen $R8 ${Var}
      IntOp $R8 $R8 - 1
      StrCpy ${Var} ${Var} $R8
    ${EndIf}
  ${EndIf}
!macroend

Function CleanupBrokenPreviousInstall
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} $0 == "" ${|} Return ${|}

  ReadRegStr $4 SHCTX "${UNINSTKEY}" "InstallLocation"
  !insertmacro _StripRegQuotes $4
  ${If} $4 == ""
    StrCpy $4 "$LOCALAPPDATA\luanpdf"
  ${EndIf}

  IfFileExists "$4\uninstall.exe" cleanup_done
    RMDir /r "$4"
    DeleteRegKey SHCTX "${UNINSTKEY}"
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"

  cleanup_done:
FunctionEnd

Function ForceCleanupPreviousInstall
  ReadRegStr $4 SHCTX "${UNINSTKEY}" "InstallLocation"
  !insertmacro _StripRegQuotes $4
  ${If} $4 == ""
    StrCpy $4 "$LOCALAPPDATA\luanpdf"
  ${EndIf}

  IfFileExists "$4\${MAINBINARYNAME}.exe" 0 +2
    Delete "$4\${MAINBINARYNAME}.exe"
  IfFileExists "$4\${PRODUCTNAME}.exe" 0 +2
    Delete "$4\${PRODUCTNAME}.exe"
  IfFileExists "$4\uninstall.exe" 0 +2
    Delete "$4\uninstall.exe"
  RMDir /r "$4"

  DeleteRegKey SHCTX "${UNINSTKEY}"
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
FunctionEnd
