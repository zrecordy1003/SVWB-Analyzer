// src/renderer/components/common/ConfirmDialog.tsx
import React from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography
} from '@mui/material'

const ConfirmDialog: React.FC<{
  open: boolean
  title: string
  message?: string
  onClose: (ok: boolean) => void
}> = ({ open, title, message, onClose }) => (
  <Dialog open={open} onClose={() => onClose(false)}>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent>
      <Typography variant="body2">{message}</Typography>
    </DialogContent>
    <DialogActions>
      <Button onClick={() => onClose(false)}>取消</Button>
      <Button variant="contained" color="error" onClick={() => onClose(true)}>
        確定
      </Button>
    </DialogActions>
  </Dialog>
)

export default ConfirmDialog
