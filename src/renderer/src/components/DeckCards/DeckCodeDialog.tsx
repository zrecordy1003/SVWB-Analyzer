/**
 * The deck code, and the race against its three-minute life.
 *
 * A published code dies three minutes after it is issued and is then recycled
 * to somebody else's deck, which is not enough time to comfortably alt-tab into
 * the game and type four characters. The portal's own page solves this by
 * re-publishing every 60 seconds while the page is open, and so does this - but
 * only while this dialog is open. Closing it stops the only recurring request
 * this app makes.
 *
 * The share link is offered alongside because it is the opposite trade: it never
 * expires, and it is what the user actually wants if they are saving the deck
 * rather than typing it in right now.
 */
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  LinearProgress,
  Stack,
  Typography
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import QrCode2RoundedIcon from '@mui/icons-material/QrCode2Rounded'
import { DECK_CODE_RENEW_MS, DECK_CODE_TTL_MS } from '@shared/deckImport'
import AppDialog from '@renderer/components/Common/AppDialog'
import React from 'react'

function publishErrorMessage(code: string): string {
  if (code === 'NETWORK') return '連不上官方牌組網站，請確認網路連線後再試一次。'
  if (code === 'UNEXPECTED_SHAPE')
    return '官方網站沒有給出有效的牌組代碼，可能是網站改版了，或這副牌不符合該形式的規則。'
  if (code.startsWith('INVALID_INPUT')) return '這副牌組沒有卡表資料，無法發行代碼。'
  if (code.startsWith('NOT_FOUND')) return '找不到這副牌組。'
  return code
}

export default function DeckCodeDialog({
  open,
  deckId,
  deckName,
  onClose,
  zIndex
}: {
  open: boolean
  deckId: number | null
  deckName: string
  onClose: () => void
  /** 疊在已經浮著的東西上面時要抬高——例如從牌組管理的抽屜裡打開。 */
  zIndex?: number
}) {
  const [loading, setLoading] = React.useState(false)
  const [code, setCode] = React.useState<string | null>(null)
  const [shareUrl, setShareUrl] = React.useState<string | null>(null)
  const [hash, setHash] = React.useState<string | null>(null)
  const [issuedAt, setIssuedAt] = React.useState<number>(0)
  const [now, setNow] = React.useState<number>(() => Date.now())
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)

  // First publish.
  React.useEffect(() => {
    if (!open || deckId == null) return
    let cancelled = false

    void (async () => {
      setLoading(true)
      setError(null)
      setCode(null)
      try {
        const res = await window.electron.ipcRenderer.invoke('decks:publishCode', { deckId })
        if (cancelled) return
        if (!res?.ok) throw new Error(publishErrorMessage(res?.error ?? 'NETWORK'))
        setCode(res.data.deckCode)
        setHash(res.data.hash)
        setShareUrl(res.data.shareUrl)
        setIssuedAt(Date.now())
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? '發行代碼失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, deckId])

  // Keep-alive, exactly as long as this dialog is open.
  React.useEffect(() => {
    if (!open || !hash) return
    const timer = setInterval(() => {
      void window.electron.ipcRenderer
        .invoke('decks:renewCode', { hash })
        .then((res) => {
          if (!res?.ok) return
          setCode(res.data.deckCode)
          setIssuedAt(Date.now())
        })
        .catch(() => {
          // A failed renewal is not worth an error banner: the countdown will
          // reach zero and say so on its own.
        })
    }, DECK_CODE_RENEW_MS)
    return () => clearInterval(timer)
  }, [open, hash])

  // Drives the countdown. One second is plenty for a three-minute clock.
  React.useEffect(() => {
    if (!open || !code) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open, code])

  const remaining = code ? Math.max(0, DECK_CODE_TTL_MS - (now - issuedAt)) : 0
  const seconds = Math.ceil(remaining / 1000)
  const expired = code !== null && remaining === 0

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      title="牌組代碼"
      subtitle={deckName}
      icon={<QrCode2RoundedIcon fontSize="small" />}
      zIndex={zIndex}
    >
      {error && (
        <Alert severity="error" sx={{ borderRadius: 2 }}>
          {error}
        </Alert>
      )}

      {loading && (
        <Stack alignItems="center" spacing={1.5} sx={{ py: 4 }}>
          <CircularProgress size={24} />
          <Typography variant="body2" color="text.secondary">
            正在向官方網站發行代碼…
          </Typography>
        </Stack>
      )}

      {code && (
        <Stack spacing={2} sx={{ py: 1 }}>
          <Stack alignItems="center" spacing={1}>
            <Typography
              sx={{
                fontSize: 44,
                fontWeight: 900,
                letterSpacing: 8,
                fontFamily: 'monospace',
                // The whole point is typing this into another window, so it
                // must stay legible after it stops being useful.
                color: expired ? 'text.disabled' : 'text.primary'
              }}
            >
              {code}
            </Typography>
            <Button
              size="small"
              startIcon={<ContentCopyIcon fontSize="small" />}
              onClick={() => void copy(code, 'code')}
            >
              {copied === 'code' ? '已複製' : '複製代碼'}
            </Button>
          </Stack>

          <Box>
            <LinearProgress
              variant="determinate"
              value={(remaining / DECK_CODE_TTL_MS) * 100}
              color={expired ? 'error' : seconds <= 30 ? 'warning' : 'primary'}
            />
            <Typography
              variant="caption"
              color={expired ? 'error.main' : 'text.secondary'}
              sx={{ display: 'block', mt: 0.75, textAlign: 'center' }}
            >
              {expired
                ? '代碼已過期，請關閉後重新發行。'
                : `剩餘 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} ・ 開著這個視窗會自動續期`}
            </Typography>
          </Box>

          <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
            在遊戲的「創建牌組」畫面輸入這 4 碼即可載入。關閉視窗後代碼不再續期，3 分鐘後失效。
          </Alert>

          {shareUrl && (
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                分享連結（沒有效期，適合長期保存）
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ flex: 1, fontFamily: 'monospace', color: 'text.secondary' }}
                  title={shareUrl}
                >
                  {shareUrl}
                </Typography>
                <Button size="small" onClick={() => void copy(shareUrl, 'url')}>
                  {copied === 'url' ? '已複製' : '複製'}
                </Button>
              </Stack>
            </Box>
          )}
        </Stack>
      )}
    </AppDialog>
  )
}
