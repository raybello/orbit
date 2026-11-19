import { useState } from 'react';
import { Icon } from './Icon';
import { PageShell } from './PageShell';
import { McpServersPane } from './skills/McpServers';
import { SkillLibraryPane } from './skills/SkillLibrary';
import '../styles/skills.css';

type Tab = 'library' | 'mcp';

/**
 * Skills: the one place for what Bots know how to do. The library holds SKILL.md skills every Bot
 * shares (turned off per Bot where one should not have it); MCP servers are the tool servers in
 * the primary agent's config, turned on per Bot.
 */
export function SkillsView() {
  const [tab, setTab] = useState<Tab>('library');
  const [adding, setAdding] = useState(false);
  return (
    <PageShell
      title="Skills"
      meta={tab === 'library'
        ? 'Shared skills every Bot can use. Type /name in a message to use one; turn a skill off for a Bot that should not have it.'
        : 'MCP servers from the primary agent’s config. Turn one on or off per Bot.'}
      actions={(
        <>
          <div className="skills-tabs" role="tablist" aria-label="Skills sections">
            <button type="button" role="tab" aria-selected={tab === 'library'} className={`skills-tab${tab === 'library' ? ' is-on' : ''}`} onClick={() => setTab('library')}>Library</button>
            <button type="button" role="tab" aria-selected={tab === 'mcp'} className={`skills-tab${tab === 'mcp' ? ' is-on' : ''}`} onClick={() => setTab('mcp')}>MCP servers</button>
          </div>
          {tab === 'library' && (
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={12} /> Add skill
            </button>
          )}
        </>
      )}
      flush
    >
      {tab === 'library' ? <SkillLibraryPane adding={adding} onAddingChange={setAdding} /> : <McpServersPane />}
    </PageShell>
  );
}
