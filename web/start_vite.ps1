$errorActionPreference = "Stop"
$process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "cd", "C:\Users\prakyath\cryptotrace-ai\web", "&", "npx", "vite", "-h", "127.0.0.1" -NoNewWindow -PassThru
Write-Host "Vite started with PID: $($process.Id)"