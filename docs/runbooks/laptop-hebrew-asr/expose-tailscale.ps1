# Expose the laptop ASR container (host port 8771) on the Tailscale IP so the
# VPS can reach it. DEV/OPS helper — run in an **Administrator PowerShell on
# Windows** (the laptop). Not part of the MeetSum app.
#
# Assumes the container is reachable on Windows localhost:8771 (Docker Desktop
# with the WSL2 backend forwards container ports to localhost). If Docker runs
# inside WSL2 without that forwarding, set -ConnectAddress to the WSL2 IP
# (`wsl hostname -I`).

param(
  [string]$TailscaleIp = "100.119.125.14",  # laptop's Tailscale IP (desktop-daaocqf-asus)
  [int]$Port = 8771,
  [string]$ConnectAddress = "127.0.0.1"
)

Write-Host "Bridging $TailscaleIp`:$Port -> $ConnectAddress`:$Port and allowing it through the firewall..."

# Remove any stale mapping, then add fresh.
netsh interface portproxy delete v4tov4 listenaddress=$TailscaleIp listenport=$Port 2>$null | Out-Null
netsh interface portproxy add v4tov4 `
  listenaddress=$TailscaleIp listenport=$Port `
  connectaddress=$ConnectAddress connectport=$Port

# Allow inbound only from the Tailscale CGNAT range (100.64.0.0/10).
$ruleName = "MeetSum ASR $Port (Tailscale)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10 | Out-Null

Write-Host "Done. Current portproxy table:"
netsh interface portproxy show v4tov4

Write-Host "`nTest from the VPS:  curl -s -m 8 http://$TailscaleIp`:$Port/v1/models"
