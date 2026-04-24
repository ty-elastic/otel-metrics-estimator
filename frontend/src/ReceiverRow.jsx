import ScraperRow from './ScraperRow'

export default function ReceiverRow({ receiver, cfg, onUpdate, onUpdateScraper, onUpdateCardinality, onUpdateResourceAttr, onRemove }) {
  if (!cfg) return null

  return (
    <>
      <tr className="recv-row">
        <td className="col-remove">
          <button className="remove-btn" onClick={onRemove} title="Remove receiver" aria-label="Remove receiver">
            ×
          </button>
        </td>
        <td className="col-chevron">
          <button
            className={`chevron-btn ${cfg.expanded ? 'open' : ''}`}
            onClick={() => onUpdate({ expanded: !cfg.expanded })}
            aria-label={cfg.expanded ? 'Collapse' : 'Expand'}
          >▶</button>
        </td>
        <td className="col-name">
          {receiver.display_name && <div className="recv-display-name">{receiver.display_name}</div>}
          <div className="recv-tech-name">{receiver.name}</div>
          <input
            type="text"
            className="purpose-input"
            placeholder="Purpose (optional)"
            value={cfg.purpose || ''}
            onChange={e => onUpdate({ purpose: e.target.value })}
          />
        </td>
        <td className="col-desc">
          <div>{receiver.description || <span className="no-desc">—</span>}</div>
          <label className="instances-label">
            <span className="instances-text">Instances</span>
            <input
              type="number"
              className="instances-input"
              value={cfg.instances}
              min={1}
              onChange={e => onUpdate({ instances: Math.max(1, Number(e.target.value)) })}
            />
          </label>
        </td>
      </tr>

      {cfg.expanded && (
        <tr className="detail-row">
          <td colSpan={4}>
            <div className="detail-panel">
              {(receiver.scrapers || []).length > 0 && (
                <div className="detail-section">
                  <div className="section-title">Scrapers</div>
                  <table className="scraper-table">
                    <thead>
                      <tr>
                        <th className="col-toggle" />
                        <th className="col-name">Scraper</th>
                        <th>Polling interval</th>
                        <th>Attributes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(receiver.scrapers || []).map(scraper => (
                        <ScraperRow
                          key={scraper.name}
                          scraper={scraper}
                          cfg={cfg.scrapers?.[scraper.name]}
                          onUpdate={patch => onUpdateScraper(scraper.name, patch)}
                          onUpdateCardinality={(aName, count) => onUpdateCardinality(scraper.name, aName, count)}
                          onUpdateResourceAttr={(aName, enabled) => onUpdateResourceAttr(scraper.name, aName, enabled)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
