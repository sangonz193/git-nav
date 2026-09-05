!include "StrFunc.nsh"
!include "WinMessages.nsh"

${StrStr}
${StrRep}

!macro BroadcastEnvironmentChange
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 ";$0;"
  ${StrStr} $2 $1 ";$INSTDIR;"
  StrCmp $2 "" 0 done

  StrCmp $0 "" 0 +3
  WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
  Goto broadcast

  WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"

  broadcast:
    !insertmacro BroadcastEnvironmentChange
  done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrRep} $0 $0 "$INSTDIR;" ""
  ${StrRep} $0 $0 ";$INSTDIR" ""
  ${StrRep} $0 $0 "$INSTDIR" ""
  WriteRegExpandStr HKCU "Environment" "Path" "$0"
  !insertmacro BroadcastEnvironmentChange
!macroend
