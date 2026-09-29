<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Spring, prefersReducedMotion } from 'svelte/motion';
  import { fade } from 'svelte/transition';
  import QRCode from 'qrcode';
  import Icon from './lib/Icon.svelte';
  import DeviceArt from './lib/DeviceArt.svelte';
  import { TransferClient, initialState } from './lib/client';
  import { translate, errorText, type CopyKey, type Language } from './lib/i18n';
  import { MAX_TEXT_BYTES } from '../shared/protocol';

  let language = $state<Language>('ja');
  let view = $state(initialState());
  let tab = $state<'create' | 'join'>('create');
  let code = $state('');
  let draft = $state('');
  let qr = $state('');
  let notice = $state('');
  let copied = $state('');
  let dragging = $state(false);
  let sending = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let textArea = $state<HTMLTextAreaElement>();
  let endDialog = $state<HTMLDialogElement>();
  let noticeTimeout: ReturnType<typeof setTimeout>;
  let copyTimeout: ReturnType<typeof setTimeout>;
  const selector = new Spring(0, { stiffness: 0.18, damping: 1, precision: 0.002 });
  const client = new TransferClient((value) => {
    view = value;
  });
  const t = (key: CopyKey) => translate(language, key);
  const size = (bytes: number) =>
    bytes >= 1_000_000
      ? (bytes / 1_000_000).toFixed(1) + ' MB'
      : bytes >= 1000
        ? (bytes / 1000).toFixed(1) + ' KB'
        : bytes + ' B';
  const textBytes = $derived(new TextEncoder().encode(draft).length);
  const home = $derived(view.phase === 'home' || view.phase === 'creating');
  const secure = $derived(view.verified && view.peerVerified);
  const available = $derived(view.phase === 'connected');
  const busy = $derived(view.phase === 'creating');
  const canSend = $derived(available && !!draft.trim() && textBytes <= MAX_TEXT_BYTES && !sending);
  const screen = $derived(home ? 'home' : secure ? 'workspace' : view.phase);
  const statusKey = $derived<CopyKey>(
    available
      ? 'connected'
      : view.phase === 'reconnecting'
        ? 'reconnecting'
        : view.phase === 'verifying'
          ? 'verifying'
          : view.phase === 'ended'
            ? 'ended'
            : 'waiting',
  );

  $effect(() => {
    document.documentElement.lang = language;
  });
  $effect(() => {
    void selector.set(tab === 'create' ? 0 : 1, { instant: prefersReducedMotion.current });
  });
  $effect(() => {
    if (view.phase === 'ended') {
      endDialog?.close();
      if (view.error === 'ended') draft = '';
    }
  });
  // Focus follows a change of task, never a progress update or incoming message.
  let previousScreen = 'home';
  $effect(() => {
    const next = screen;
    if (next !== previousScreen) {
      previousScreen = next;
      void tick().then(() =>
        document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true }),
      );
    }
  });
  $effect(() => {
    const url = view.inviteUrl;
    if (!url) {
      qr = '';
      return;
    }
    let current = true;
    QRCode.toDataURL(url, {
      width: 288,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#17243b', light: '#ffffff' },
    }).then((value) => {
      if (current) qr = value;
    });
    return () => {
      current = false;
    };
  });
  onMount(() => {
    language = navigator.language.startsWith('ja') ? 'ja' : 'en';
    const fragment = new URLSearchParams(location.hash.slice(1));
    const inviteCode = fragment.get('code');
    const key = fragment.get('key');
    // Remove the secret from the address bar/history before doing any network work.
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (inviteCode && /^\d{6}$/.test(inviteCode) && key && /^[A-Za-z0-9_-]{43}$/.test(key))
      void client.join(inviteCode, key);
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      if (draft.trim() || view.outgoing || view.incoming) event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeLeave);
    return () => {
      clearTimeout(noticeTimeout);
      clearTimeout(copyTimeout);
      window.removeEventListener('beforeunload', warnBeforeLeave);
      client.destroy();
    };
  });
  function flash(message: string) {
    clearTimeout(noticeTimeout);
    notice = message;
    noticeTimeout = setTimeout(() => {
      notice = '';
    }, 3500);
  }
  async function copy(value: string, id: string) {
    try {
      await navigator.clipboard.writeText(value);
      clearTimeout(copyTimeout);
      copied = id;
      copyTimeout = setTimeout(() => {
        copied = '';
      }, 2500);
      flash(t('copied'));
    } catch {
      flash(t('copyFailed'));
    }
  }
  async function paste() {
    try {
      draft = await navigator.clipboard.readText();
    } catch {
      flash(t('pasteFailed'));
    }
    textArea?.focus();
  }
  async function send() {
    if (!canSend) return;
    const value = draft;
    sending = true;
    try {
      if (await client.sendText(value)) {
        if (draft === value) draft = '';
        textArea?.focus();
      }
    } finally {
      sending = false;
    }
  }
  function end() {
    endDialog?.close();
    client.end();
    draft = '';
    code = '';
    copied = '';
    notice = '';
    tab = 'create';
  }
  function requestEnd() {
    if (draft.trim() || view.history.length || view.outgoing || view.incoming)
      endDialog?.showModal();
    else end();
  }
  function urlOf(value: string) {
    try {
      const url = new URL(value.trim());
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }
  function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    tab =
      event.key === 'Home'
        ? 'create'
        : event.key === 'End'
          ? 'join'
          : tab === 'create'
            ? 'join'
            : 'create';
    document.getElementById(tab + '-tab')?.focus();
  }
  function selectFile(event: Event) {
    const element = event.target as HTMLInputElement;
    const file = element.files?.[0];
    if (file) void client.sendFile(file);
    element.value = '';
  }
  async function acceptFile() {
    const id = view.incoming?.id;
    if (!id) return;
    await client.acceptFile();
    await tick();
    // Follow the explicit receive action to its progress/save controls. Incoming
    // offers alone never steal focus or scroll the page while someone is typing.
    const entry = document.getElementById('entry-' + id);
    entry?.focus({ preventScroll: true });
    entry?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion.current ? 'instant' : 'smooth',
    });
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    if (event.dataTransfer && event.dataTransfer.files.length > 1) {
      flash(t('oneFile'));
      return;
    }
    if (available && !view.outgoing && event.dataTransfer?.files[0])
      void client.sendFile(event.dataTransfer.files[0]);
  }
</script>

<svelte:head><title>Textrans — {t('tagline')}</title></svelte:head>

{#snippet errorBanner()}
  <div class="error-banner" role="alert">
    <Icon name="alert" size={19} /><span>{errorText(language, view.error)}</span>
    <button class="icon-button" onclick={() => client.clearError()} aria-label={t('clear')}
      ><Icon name="close" size={18} /></button
    >
  </div>
{/snippet}

<a class="skip-link" href="#main">{t('skip')}</a>
<div class="page-shell" class:in-session={!home}>
  <header class="site-header">
    <div class="header-inner">
      <a
        class="brand"
        href="/"
        onclick={(event) => {
          event.preventDefault();
          requestEnd();
        }}
        aria-label="Textrans"
      >
        <span class="brand-mark"><Icon name="arrows" size={21} /></span><span>textrans</span>
      </a>
      <span class="header-caption">{t('tagline')}</span>
      <button
        class="language"
        onclick={() => {
          language = language === 'ja' ? 'en' : 'ja';
        }}
        aria-label={language === 'ja' ? 'Switch to English' : '日本語に切り替える'}
        ><Icon name="globe" size={17} />{language === 'ja' ? 'EN' : '日本語'}</button
      >
    </div>
  </header>

  <main id="main" tabindex="-1">
    {#if home}
      <div class="home-layout">
        <section class="intro">
          <DeviceArt />
          <h1 tabindex="-1">{t('tagline')}</h1>
          <p class="description">{t('description')}</p>
        </section>
        <section class="connect-card surface" aria-label={t('connect')}>
          <div class="tab-row" role="tablist" aria-label={t('connect')}>
            <span
              class="tab-selector"
              style:transform={'translateX(' + selector.current * 100 + '%)'}
              aria-hidden="true"
            ></span>
            <button
              role="tab"
              id="create-tab"
              aria-controls="connect-panel"
              aria-selected={tab === 'create'}
              tabindex={tab === 'create' ? 0 : -1}
              onkeydown={tabKey}
              onclick={() => {
                tab = 'create';
              }}>{t('create')}</button
            >
            <button
              role="tab"
              id="join-tab"
              aria-controls="connect-panel"
              aria-selected={tab === 'join'}
              tabindex={tab === 'join' ? 0 : -1}
              onkeydown={tabKey}
              onclick={() => {
                tab = 'join';
              }}>{t('enter')}</button
            >
          </div>
          <div
            id="connect-panel"
            class="connect-panel"
            role="tabpanel"
            aria-labelledby={tab + '-tab'}
            aria-busy={busy}
          >
            {#if tab === 'create'}
              <div class="connect-explainer" in:fade={{ duration: 120 }}>
                <span class="feature-icon"><Icon name="qr" size={26} /></span>
                <h2>{t('createTitle')}</h2>
                <p>{t('createHelp')}</p>
              </div>
              <button class="primary full" disabled={busy} onclick={() => client.create()}
                >{#if busy}<span class="spinner small" aria-hidden="true"></span>{/if}{busy
                  ? t('working')
                  : t('createButton')}{#if !busy}<Icon name="arrow" size={18} />{/if}</button
              >
            {:else}
              <form
                onsubmit={(event) => {
                  event.preventDefault();
                  if (code.length === 6 && !busy) void client.join(code);
                }}
                in:fade={{ duration: 120 }}
              >
                <div class="join-copy">
                  <label for="join-code">{t('codeLabel')}</label>
                  <p>{t('joinHelp')}</p>
                </div>
                <input
                  id="join-code"
                  class="code-input"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern={'[0-9]{6}'}
                  placeholder="000000"
                  value={code}
                  oninput={(event) => {
                    code = event.currentTarget.value
                      .normalize('NFKC')
                      .replace(/\D/g, '')
                      .slice(0, 6);
                    event.currentTarget.value = code;
                    if (view.error) client.clearError();
                  }}
                  required
                  aria-invalid={!!view.error}
                  aria-describedby="join-code-help"
                />
                <p id="join-code-help" class="input-hint">{t('joinCodeHint')}</p>
                <button class="primary full" disabled={code.length !== 6 || busy}
                  >{#if busy}<span class="spinner small" aria-hidden="true"></span>{/if}{busy
                    ? t('working')
                    : t('joinButton')}{#if !busy}<Icon name="arrow" size={18} />{/if}</button
                >
              </form>
            {/if}
            {#if view.error}{@render errorBanner()}{/if}
            {#if busy}<button class="quiet-button busy-cancel" onclick={end}>{t('cancel')}</button
              >{/if}
          </div>
        </section>
        <div class="trust-note"><Icon name="lock" size={15} /><span>{t('homeTrust')}</span></div>
      </div>
    {:else}
      <div class="session-shell" class:wide={secure}>
        <div class="session-heading">
          <div
            class="status"
            class:connected={available}
            class:reconnecting={view.phase === 'reconnecting'}
          >
            <span class="status-dot" aria-hidden="true"></span><span aria-live="polite"
              >{t(statusKey)}</span
            >
          </div>
          {#if view.phase !== 'ended'}<button class="quiet-button end-button" onclick={requestEnd}
              >{t(secure ? 'end' : 'cancel')}<Icon name="close" size={15} /></button
            >{/if}
        </div>
        {#if view.error && view.phase !== 'ended'}{@render errorBanner()}{/if}
        {#if view.phase === 'waiting' && view.connection?.role === 'host' && !view.paired}
          <section class="pair-card surface" in:fade={{ duration: 160 }}>
            <h1 tabindex="-1">{t('scan')}</h1>
            <p class="section-description">{t('scanHelp')}</p>
            <div class="qr-wrap">
              {#if qr}<img src={qr} width="240" height="240" alt={t('qrAlt')} />{:else}<div
                  class="qr-placeholder"
                >
                  <span class="spinner" aria-hidden="true"></span><span class="sr-only"
                    >{t('working')}</span
                  >
                </div>{/if}
            </div>
            <div class="countdown" class:expiring={view.remaining < 30}>
              <Icon name="clock" size={14} /><span>{t('expires')}</span><strong
                >{Math.floor(view.remaining / 60)}:{String(view.remaining % 60).padStart(
                  2,
                  '0',
                )}</strong
              >
            </div>
            <div class="or-divider"><span>{t('orCode')}</span></div>
            <button
              class="invite-code"
              onclick={() => copy(view.connection!.code, 'code')}
              aria-label={t('copyCode')}
              ><strong data-testid="invite-code">{view.connection.code}</strong><Icon
                name={copied === 'code' ? 'check' : 'copy'}
                size={20}
              /></button
            >
            <p class="code-instruction">{t('codeInstruction')}</p>
            <button
              class="secondary full invite-link"
              onclick={() => copy(view.inviteUrl, 'invite')}
              ><Icon name={copied === 'invite' ? 'check' : 'link'} size={18} />{t(
                copied === 'invite' ? 'copied' : 'link',
              )}</button
            >
          </section>
          <p class="under-card"><Icon name="lock" size={15} />{t('pairTrust')}</p>
        {:else if view.phase === 'verifying' && !secure}
          <section class="verify-card surface" in:fade={{ duration: 160 }}>
            <span class="state-icon"><Icon name="shield" size={30} /></span>
            <h1 tabindex="-1">{t('verifying')}</h1>
            <p class="section-description">{t('verifyHelp')}</p>
            <div class="sas" data-testid="sas">
              {#each view.sas.split(' · ') as group}<span>{group}</span>{/each}
            </div>
            {#if view.verified}<div class="verification-wait" role="status">
                <span class="spinner small" aria-hidden="true"></span>{t('verifyWaiting')}
              </div>{:else}<button class="primary full" onclick={() => client.verify()}
                ><Icon name="check" size={20} />{t('verify')}</button
              >{/if}
            <button class="quiet-button reject-button" onclick={end}>{t('reject')}</button>
          </section>
        {:else if secure}
          {#if view.phase === 'reconnecting'}<div class="connection-note" role="status">
              <span class="spinner small" aria-hidden="true"></span>
              <p>{t('reconnectHelp')}</p>
            </div>{/if}
          <div class="workspace">
            {#if view.incoming}
              <section
                class="incoming-card"
                aria-labelledby="incoming-title"
                in:fade={{ duration: 160 }}
              >
                <div class="incoming-info">
                  <span class="file-icon"><Icon name="download" size={25} /></span>
                  <div>
                    <h2 id="incoming-title" role="status">{t('incoming')}</h2>
                    <p class="incoming-name">{view.incoming.name}</p>
                    <span class="file-size">{size(view.incoming.size)}</span>
                  </div>
                </div>
                <div class="incoming-actions">
                  <button class="secondary" onclick={() => client.cancelFile(view.incoming!.id)}
                    >{t('decline')}</button
                  ><button class="primary" disabled={!available} onclick={acceptFile}
                    ><Icon name="download" size={18} />{t('accept')}</button
                  >
                </div>
              </section>
            {/if}
            <section class="compose-card surface">
              <div class="compose-heading">
                <h1 tabindex="-1">{t('ready')}</h1>
                <span class="encrypted-badge" title={t('private')}
                  ><Icon name="lock" size={15} /><span>{t('private')}</span></span
                >
              </div>
              <div class="editor-label">
                <label for="text-draft">{t('compose')}</label><button
                  class="quiet-button"
                  onclick={paste}><Icon name="paste" size={16} />{t('paste')}</button
                >
              </div>
              <div class="editor" class:over={textBytes > MAX_TEXT_BYTES}>
                <textarea
                  id="text-draft"
                  bind:this={textArea}
                  bind:value={draft}
                  placeholder={t('placeholder')}
                  aria-invalid={textBytes > MAX_TEXT_BYTES}
                  aria-describedby={textBytes > MAX_TEXT_BYTES ? 'text-limit-error' : undefined}
                  onkeydown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === 'Enter' &&
                      !event.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}></textarea>
                <div class="editor-meta">
                  <span class="shortcut">{t('shortcut')}</span><span class="byte-count"
                    >{size(textBytes)} / 64 KiB</span
                  >
                </div>
              </div>
              {#if textBytes > MAX_TEXT_BYTES}<p
                  class="field-error"
                  id="text-limit-error"
                  role="alert"
                >
                  {t('text-too-large')}
                </p>{/if}
              <button class="primary full send-button" disabled={!canSend} onclick={send}
                >{t('send')}<Icon name="arrow" size={19} /></button
              >
              <div
                class="file-drop"
                class:dragging
                ondragover={(event) => {
                  event.preventDefault();
                  if (available && !view.outgoing) dragging = true;
                }}
                ondragleave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) dragging = false;
                }}
                ondrop={drop}
                role="group"
                aria-label={t('file')}
              >
                <input
                  bind:this={fileInput}
                  type="file"
                  onchange={selectFile}
                  aria-label={t('file')}
                  hidden
                />
                <button
                  class="file-picker"
                  disabled={!available || view.outgoing}
                  onclick={() => fileInput?.click()}
                  ><span class="file-picker-icon"
                    ><Icon name={view.outgoing ? 'upload' : 'plus'} size={23} /></span
                  ><span
                    ><strong>{view.outgoing ? t('fileBusy') : t('file')}</strong><span
                      class="file-hint">{dragging ? t('dropNow') : t('fileHelp')}</span
                    ></span
                  ><Icon name="arrow" size={18} /></button
                >
              </div>
            </section>
            <section class="history-panel" aria-labelledby="history-title">
              <div class="history-heading">
                <h2 id="history-title">{t('history')}</h2>
                <span class="history-count">{view.history.length}</span>
              </div>
              <p class="history-note">{t('localHistory')}</p>
              {#if !view.history.length}<div class="empty-history">
                  <span class="empty-icon"><Icon name="inbox" size={31} /></span>
                  <h3>{t('emptyTitle')}</h3>
                  <p>{t('empty')}</p>
                </div>{/if}
              {#each view.history as entry (entry.id)}
                {#if !(entry.id === view.incoming?.id && entry.status === 'offered')}
                  <article
                    class="history-entry"
                    id={'entry-' + entry.id}
                    tabindex="-1"
                    class:received={entry.direction === 'in'}
                    data-testid="history-entry"
                    in:fade={{ duration: 150 }}
                  >
                    <div class="entry-top">
                      <span class="entry-direction"
                        ><Icon
                          name={entry.direction === 'out' ? 'upload' : 'download'}
                          size={14}
                        />{t(entry.direction === 'out' ? 'you' : 'peer')}</span
                      ><span>{entry.kind === 'file' ? size(entry.size || 0) : t('text')}</span>
                    </div>
                    {#if entry.kind === 'text'}<pre
                        class="received-text">{entry.text}</pre>{:else}<div class="file-content">
                        <span class="file-icon"><Icon name="file" size={25} /></span>
                        <h3 class="file-name">{entry.name}</h3>
                      </div>{/if}
                    {#if entry.status === 'transferring'}<progress
                        max="1"
                        value={entry.progress || 0}
                        aria-label={t('transferring')}
                      ></progress>{/if}
                    <div class="entry-bottom">
                      <span class="delivery-status" class:complete={entry.status === 'delivered'}
                        >{#if entry.status === 'delivered'}<Icon name="check" size={13} />{/if}{t(
                          entry.status === 'delivered' && entry.direction === 'in'
                            ? 'received'
                            : entry.status,
                        )}{entry.status === 'transferring'
                          ? ' ' + Math.round((entry.progress || 0) * 100) + '%'
                          : ''}</span
                      >
                      <div class="entry-actions">
                        {#if entry.kind === 'text'}<button
                            class="action-button"
                            onclick={() => copy(entry.text!, entry.id)}
                            ><Icon name={copied === entry.id ? 'check' : 'copy'} size={16} />{t(
                              copied === entry.id ? 'copied' : 'copy',
                            )}</button
                          >{#if urlOf(entry.text!)}<a
                              class="action-button"
                              href={urlOf(entry.text!)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              ><Icon name="external" size={16} />{t('open')}</a
                            >{/if}{/if}
                        {#if entry.url}<a
                            class="action-button save-button"
                            href={entry.url}
                            download={entry.name}><Icon name="download" size={16} />{t('save')}</a
                          >{/if}
                        {#if entry.kind === 'file' && ['offered', 'transferring'].includes(entry.status)}<button
                            class="action-button"
                            onclick={() => client.cancelFile(entry.id)}
                            ><Icon name="close" size={15} />{t('cancel')}</button
                          >{/if}
                      </div>
                    </div>
                  </article>
                {/if}
              {/each}
            </section>
          </div>
        {:else if view.phase === 'ended'}
          <section class="verify-card ended-card surface" in:fade={{ duration: 160 }}>
            <span class="state-icon"
              ><Icon name={view.error === 'ended' ? 'check' : 'alert'} size={30} /></span
            >
            <h1 tabindex="-1">{t('ended')}</h1>
            <p class="section-description">
              {view.error === 'ended' ? t('endedHelp') : errorText(language, view.error)}
            </p>
            {#each view.history as entry}<article class="history-entry">
                <p class="recovery-label">{t('unsent')}</p>
                <pre class="received-text">{entry.text}</pre>
                <button class="action-button" onclick={() => copy(entry.text!, entry.id)}
                  ><Icon name={copied === entry.id ? 'check' : 'copy'} size={16} />{t(
                    copied === entry.id ? 'copied' : 'copy',
                  )}</button
                >
              </article>{/each}
            {#if draft}<article class="history-entry">
                <p class="recovery-label">{t('unsent')}</p>
                <pre class="received-text">{draft}</pre>
                <button class="action-button" onclick={() => copy(draft, 'draft')}
                  ><Icon name={copied === 'draft' ? 'check' : 'copy'} size={16} />{t(
                    copied === 'draft' ? 'copied' : 'copy',
                  )}</button
                >
              </article>{/if}
            <button class="primary full" onclick={requestEnd}
              >{t('again')}<Icon name="arrow" size={18} /></button
            >
          </section>
        {:else}<section class="verify-card surface">
            <span class="spinner large" aria-hidden="true"></span>
            <h1 tabindex="-1">{t('working')}</h1>
            <p class="section-description">{t('footer')}</p>
          </section>{/if}
      </div>
    {/if}
  </main>
  <footer class="site-footer">
    <p>{t('footer')}</p>
    <details>
      <summary>{t('privacy')}</summary>
      <p>{t('privacyText')}</p>
    </details>
  </footer>
</div>

<dialog
  bind:this={endDialog}
  class="end-dialog"
  aria-labelledby="end-title"
  aria-describedby="end-description"
>
  <span class="state-icon"><Icon name="arrows" size={27} /></span>
  <h2 id="end-title">{t('endTitle')}</h2>
  <p id="end-description">{t('endHelp')}</p>
  <div class="dialog-actions">
    <button class="secondary" onclick={() => endDialog?.close()}>{t('keepConnection')}</button
    ><button class="danger-button" onclick={end}>{t('endConfirm')}</button>
  </div>
</dialog>
{#if notice}<div
    class="toast"
    role="status"
    in:fade={{ duration: 120 }}
    out:fade={{ duration: 120 }}
  >
    <Icon name={notice === t('copied') ? 'check' : 'alert'} size={18} />{notice}
  </div>{/if}
