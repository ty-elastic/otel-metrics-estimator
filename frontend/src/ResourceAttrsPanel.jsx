export default function ResourceAttrsPanel({ processors, config, onToggleProcessor, onToggleAttr }) {
  if (!processors || processors.length === 0) return null

  return (
    <div className="ra-panel">
      <div className="ra-panel-title">Resource Attributes</div>
      <div className="ra-processors">
        {processors.map(proc => {
          const pcfg = config[proc.processor] || {}
          const expanded = pcfg.expanded || false
          const enabled  = pcfg.enabled  ?? true

          return (
            <div key={proc.processor} className={`ra-proc ${enabled ? 'ra-proc-on' : 'ra-proc-off'}`}>
              {/* Processor header row */}
              <div className="ra-proc-header">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => onToggleProcessor(proc.processor, 'enabled', !enabled)}
                />
                <button
                  className={`chevron-btn ${expanded ? 'open' : ''}`}
                  onClick={() => onToggleProcessor(proc.processor, 'expanded', !expanded)}
                  aria-label={expanded ? 'Collapse' : 'Expand'}
                >
                  ▶
                </button>
                <span className="ra-proc-label">{proc.label}</span>
                <span className="ra-proc-key">{proc.processor}</span>
                <span className="ra-proc-count">
                  {Object.values(pcfg.attributes || {}).filter(Boolean).length} / {proc.attributes.length}
                </span>
              </div>

              {/* Expanded attribute list */}
              {expanded && (
                <div className="ra-attr-list">
                  {proc.attributes.map(attr => {
                    const attrEnabled = pcfg.attributes?.[attr.name] ?? true
                    return (
                      <label key={attr.name} className={`ra-attr-row ${attrEnabled ? '' : 'ra-attr-off'}`}>
                        <input
                          type="checkbox"
                          checked={attrEnabled}
                          onChange={() => onToggleAttr(proc.processor, attr.name, !attrEnabled)}
                        />
                        <span className="ra-attr-name">{attr.name}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
