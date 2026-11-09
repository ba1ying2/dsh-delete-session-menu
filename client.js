/**
 * dsh-session-delete — browser half.
 *
 * Contributes one `sidebar.workspaces.session.menu.item` row and the
 * `shell.overlay` confirmation dialog it raises. The row lives in the
 * per-conversation "…" menu next to pin / rename / fork / archive; the dialog
 * lives in the overlay slot because the menu — and the row that owns it —
 * unmounts as soon as it closes.
 *
 * Confirming posts to the host half's `POST /session-delete/exec` through a
 * page-relative URL, so a GUI served under a reverse-proxy prefix keeps
 * working. A successful deletion reloads the page: the host has already
 * dropped the durable log and emitted `api-session/removed`, and the reload
 * clears the client's own session and projection caches for the id.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-menu-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const ROUTE = 'session-delete/exec'

    // ---- copy: follow the workspace language, default to English ----
    function currentLanguage() {
      try {
        const tag = document.documentElement.lang || navigator.language || 'en'
        return String(tag).toLowerCase()
      } catch {
        return 'en'
      }
    }
    const COPY = {
      zh: {
        menu: '删除会话',
        title: '删除会话',
        description: (name) => `“${name}”的对话记录会从本机永久删除，无法恢复。`,
        note: '删除后，该会话将从侧栏消失；它占用的会话日志文件也会被移除。',
        cancel: '取消',
        confirm: '删除',
        busy: '删除中…',
        close: '关闭',
      },
      en: {
        menu: 'Delete conversation',
        title: 'Delete conversation',
        description: (name) => `“${name}” will be deleted from this machine permanently. This cannot be undone.`,
        note: 'The conversation disappears from the sidebar, and its session log file is removed.',
        cancel: 'Cancel',
        confirm: 'Delete',
        busy: 'Deleting…',
        close: 'Close',
      },
    }
    const t = () => (currentLanguage().startsWith('zh') ? COPY.zh : COPY.en)

    // ---- one-shot request store shared by the menu row and the dialog ----
    const listeners = new Set()
    let pending = null
    const notify = () => {
      for (const listener of listeners) listener()
    }
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const snapshot = () => pending
    const requestDelete = (request) => {
      pending = request
      notify()
    }
    const settle = () => {
      pending = null
      notify()
    }
    function usePending() {
      return React.useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    /** POST the deletion, resolving with the host's value or rejecting with its message. */
    async function callDelete(sessionId) {
      const url = new URL(ROUTE, document.baseURI)
      let response
      try {
        response = await fetch(url.href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      const parsed = await response.json().catch(() => null)
      if (!response.ok || parsed === null || parsed.ok !== true) {
        throw new Error(
          parsed !== null && typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`,
        )
      }
      return parsed.value
    }

    /**
     * Menu row: close the owner menu first, then raise the confirmation. The
     * menu open state arrives through the slot's shared hook context.
     */
    function DeleteSessionMenuItem(props) {
      const sessionId = props.sessionId
      const displayTitle = props.displayTitle
      const useMenuOpenState = props.useMenuOpenState
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      const setMenuOpen = Array.isArray(menuState) ? menuState[1] : undefined
      return React.createElement(
        primitives.MenuItemButton,
        {
          icon: React.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
          onSelect: () => {
            if (typeof setMenuOpen === 'function') setMenuOpen(false)
            requestDelete({ sessionId, displayTitle })
          },
        },
        t().menu,
      )
    }

    /** The overlay entry: nothing while no confirmation is pending. */
    function DeleteSessionDialog() {
      const request = usePending()
      if (request === null) return null
      return React.createElement(DeleteConfirmForm, { request, key: request.sessionId })
    }

    /** One request's dialog; in-flight and error state die with it. */
    function DeleteConfirmForm(props) {
      const request = props.request
      const copy = t()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const close = () => {
        if (busy) return
        settle()
      }
      const confirm = () => {
        if (busy) return
        setBusy(true)
        setError(null)
        callDelete(request.sessionId)
          .then(() => {
            settle()
            // The row is already gone host-side; reload re-reads the catalog
            // and drops any client-side projection cache for the id.
            setTimeout(() => {
              window.location.reload()
            }, 120)
          })
          .catch((reason) => {
            setBusy(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          })
      }
      const name = request.displayTitle === undefined || request.displayTitle === ''
        ? request.sessionId
        : request.displayTitle
      const footer = React.createElement(
        React.Fragment,
        null,
        React.createElement(primitives.Button, { variant: 'outline', disabled: busy, onClick: close }, copy.cancel),
        React.createElement(primitives.Button, { variant: 'primary', disabled: busy, onClick: confirm }, busy ? copy.busy : copy.confirm),
      )
      return React.createElement(
        primitives.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: copy.close,
          title: copy.title,
          description: copy.description(name),
          footer,
        },
        [
          React.createElement(
            'div',
            { key: 'warning', style: { lineHeight: '20px' } },
            copy.note,
          ),
          error !== null
            ? React.createElement(
              'div',
              {
                key: 'error',
                role: 'alert',
                style: { marginTop: '8px', color: 'var(--dsw-alias-state-warning-primary, #d44)' },
              },
              error,
            )
            : null,
        ],
      )
    }

    /** Client plugin body: register the menu row and its dialog. */
    function apply(ctx) {
      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: 'session-delete',
        order: 500,
      }, DeleteSessionMenuItem))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: 'session-delete-confirm',
      }, DeleteSessionDialog))
    }

    exports.name = 'dsh-session-menu-delete'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
