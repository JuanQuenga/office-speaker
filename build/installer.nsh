; Office Speaker downloads Spotify Soloist into ProgramData at first run (Soloist
; can't be bundled). Give regular users write access there, and let Spotify apps
; on the network reach Soloist and our mDNS announcer through Windows Firewall.
;
; The installer force-closes a running Office Speaker, which can't stop its
; Soloist child on Windows, so stop any Soloist here too.
!macro customInstall
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM soloist.exe'
  Pop $1
  ReadEnvStr $0 ProgramData
  CreateDirectory "$0\Office Speaker\soloist"
  nsExec::Exec 'icacls "$0\Office Speaker" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
  Pop $1
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker"'
  Pop $1
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker (Soloist)"'
  Pop $1
  nsExec::Exec 'netsh advfirewall firewall add rule name="Office Speaker" dir=in action=allow program="$INSTDIR\Office Speaker.exe" enable=yes profile=domain,private,public'
  Pop $1
  nsExec::Exec 'netsh advfirewall firewall add rule name="Office Speaker (Soloist)" dir=in action=allow program="$0\Office Speaker\soloist\bin\soloist.exe" enable=yes profile=domain,private,public'
  Pop $1
!macroend

!macro customUnInstall
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM soloist.exe'
  Pop $1
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker"'
  Pop $1
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker (Soloist)"'
  Pop $1
!macroend
