; Office Speaker downloads Spotify Soloist into ProgramData at first run (Soloist
; can't be bundled). Give regular users write access there, and let Spotify apps
; on the network reach Soloist and our mDNS announcer through Windows Firewall.
!macro customInstall
  ReadEnvStr $0 ProgramData
  CreateDirectory "$0\Office Speaker\soloist"
  nsExec::Exec 'icacls "$0\Office Speaker" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker (Soloist)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Office Speaker" dir=in action=allow program="$INSTDIR\Office Speaker.exe" enable=yes profile=domain,private,public'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Office Speaker (Soloist)" dir=in action=allow program="$0\Office Speaker\soloist\bin\soloist.exe" enable=yes profile=domain,private,public'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker (Soloist)"'
!macroend
