import { useState, useEffect, useRef } from 'react'

export default function AddReceiverModal({ receivers, onAdd, onClose }) {
  const [search, setSearch] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const q = search.toLowerCase()
  const filtered = receivers.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.display_name || '').toLowerCase().includes(q) ||
    (r.description || '').toLowerCase().includes(q)
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Add Receiver</h2>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-search-wrap">
          <input
            ref={inputRef}
            type="text"
            className="modal-search"
            placeholder="Search receivers…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="modal-list">
          {filtered.length === 0 ? (
            <div className="modal-empty">No receivers match "{search}"</div>
          ) : (
            filtered.map(recv => (
              <button
                key={recv.name}
                className="modal-recv-item"
                onClick={() => { onAdd(recv.name); onClose() }}
              >
                <div className="modal-recv-names">
                  {recv.display_name && (
                    <span className="modal-recv-display">{recv.display_name}</span>
                  )}
                  <span className="modal-recv-tech">{recv.name}</span>
                </div>
                {recv.description && (
                  <div className="modal-recv-desc">{recv.description}</div>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
