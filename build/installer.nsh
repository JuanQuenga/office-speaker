; Let Spotify apps on the network reach the speaker engine (mDNS + the Connect
; handshake). Without this rule Windows Firewall silently blocks discovery.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Office Speaker" dir=in action=allow program="$INSTDIR\resources\engine\speaker-engine.exe" enable=yes profile=domain,private,public'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Speaker"'
!macroend
