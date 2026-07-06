param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$files = Get-ChildItem -Path $Path -Filter "*.exe" -File

if ($files.Count -eq 0) {
  throw "No Windows executable artifacts found at $Path"
}

foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -FilePath $file.FullName

  if ($signature.Status -ne "Valid") {
    throw "Invalid Authenticode signature for $($file.Name): $($signature.Status) $($signature.StatusMessage)"
  }

  Write-Host "Verified Authenticode signature for $($file.Name): $($signature.SignerCertificate.Subject)"
}
