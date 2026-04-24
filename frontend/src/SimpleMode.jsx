export default function SimpleMode({ templates, simpleEnvs, simpleInputs, onToggleEnv, onSetInput }) {
  const environments = templates.find(t => t.environments)?.environments || []
  const sources = templates.find(t => t.sources)?.sources || []

  if (environments.length === 0 && sources.length === 0) {
    return (
      <div className="simple-empty">
        No simple mode templates configured. Add a <code>simple:</code> block to your config file.
      </div>
    )
  }

  return (
    <div className="simple-mode">
      {environments.length > 0 && (
        <section className="simple-section">
          <div className="simple-section-title">Environments</div>
          <div className="simple-env-list">
            {environments.map(env => {
              const forcedOn = env.enabled === false
              const checked = forcedOn ? true : (simpleEnvs[env.name] ?? false)
              return (
                <label key={env.name} className={`simple-env-item ${checked ? 'simple-env-on' : ''} ${forcedOn ? 'simple-env-forced' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={forcedOn}
                    onChange={forcedOn ? undefined : e => onToggleEnv(env.name, e.target.checked)}
                  />
                  <span className="simple-env-name">{env.name}</span>
                  {env.attributes && env.attributes.length > 0 && (
                    <span className="simple-env-attrs">
                      {env.attributes.length} attribute{env.attributes.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </label>
              )
            })}
          </div>
        </section>
      )}

      {sources.length > 0 && (
        <section className="simple-section">
          <div className="simple-section-title">Sources</div>
          <div className="simple-source-list">
            {sources.map(source => (
              <div key={source.name} className="simple-source-row">
                <div className="simple-source-name">{source.name}</div>
                <div className="simple-source-inputs">
                  {(source.inputs || []).map((input, i) => {
                    const val = simpleInputs[source.name]?.[i] ?? 0
                    return (
                      <label key={i} className="simple-input-field">
                        <span className="simple-input-label">{input.label}</span>
                        <input
                          type="number"
                          className="simple-quantity-input"
                          value={val}
                          min={0}
                          onChange={e => onSetInput(source.name, i, Math.max(0, Number(e.target.value)))}
                        />
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
