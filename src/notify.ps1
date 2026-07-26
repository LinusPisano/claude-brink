# Brink — Windows toast helper (Phase 2). The Windows leaf called by notify.js,
# which owns cross-platform desktop notifications. AppId reuses the Claude.Code path.
param([string]$Msg)

# native Windows toast
try {
  [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
  $x = New-Object Windows.Data.Xml.Dom.XmlDocument
  $safe = [System.Security.SecurityElement]::Escape($Msg)
  $x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>Brink</text><text>$safe</text></binding></visual></toast>")
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude.Code').Show([Windows.UI.Notifications.ToastNotification]::new($x))
} catch {}
