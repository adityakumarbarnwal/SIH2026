import { useEffect, useRef } from 'react'

/**
 * Isolated React hook for patient speech-to-text keyword capture.
 * Completely self-contained: errors are caught internally and never escape to parent components.
 */
function safeLang(langHint) {
  try {
    const map = { en: 'en-IN', hi: 'hi-IN', pa: 'pa-IN', mr: 'mr-IN', bn: 'bn-IN' }
    const key = String(langHint || '').toLowerCase().trim().split('-')[0]
    return map[key] || 'en-IN'
  } catch {
    return 'en-IN'
  }
}

export function usePatientKeywordCapture({ enabled, roomId, socketRef, streamRef, language }) {
  const recognitionRef = useRef(null)

  useEffect(() => {
    // Isolated execution wrapped in top-level try/catch
    let active = true
    let timerId = null

    try {
      if (!enabled || !roomId || !streamRef?.current) return

      const SpeechRecognition = typeof window !== 'undefined'
        ? (window.SpeechRecognition || window.webkitSpeechRecognition)
        : null

      if (!SpeechRecognition) {
        console.warn('[usePatientKeywordCapture] Web Speech API not supported in browser.')
        return
      }

      // Delay initialization so WebRTC media stream settles first
      timerId = setTimeout(() => {
        if (!active) return

        try {
          const recognition = new SpeechRecognition()
          recognitionRef.current = recognition
          recognition.continuous = true
          recognition.interimResults = false
          recognition.lang = safeLang(language)

          recognition.onresult = (event) => {
            try {
              for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i]?.isFinal) {
                  const text = event.results[i][0]?.transcript?.trim()
                  if (text && socketRef?.current) {
                    socketRef.current.emit('transcript-chunk', { roomId, text })
                  }
                }
              }
            } catch (err) {
              console.warn('[usePatientKeywordCapture] Non-fatal result error:', err)
            }
          }

          recognition.onerror = (e) => {
            if (e.error !== 'no-speech') {
              console.warn('[usePatientKeywordCapture] Non-fatal STT warning:', e.error)
            }
          }

          recognition.onend = () => {
            if (active && socketRef?.current) {
              try { recognition.start() } catch { /* ignore */ }
            }
          }

          recognition.start()
        } catch (err) {
          console.warn('[usePatientKeywordCapture] Recognition start warning:', err?.message)
        }
      }, 1500)
    } catch (err) {
      console.warn('[usePatientKeywordCapture] Hook setup warning:', err?.message)
    }

    return () => {
      active = false
      if (timerId) clearTimeout(timerId)
      try { recognitionRef.current?.stop?.() } catch { /* ignore */ }
      recognitionRef.current = null
    }
  }, [enabled, roomId, streamRef, language, socketRef])
}
