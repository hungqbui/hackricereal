/**
 * The four-tab shell: header, the active screen, bottom nav.
 *
 * There is still no router — the tab lives in state and mirrors into the hash,
 * so the browser's back button and a reload both land where you left off
 * without pulling in a routing dependency.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { LogoUniBite, IconAdvisor, IconDining, IconMyMeals, IconUser } from './icons'
import { Avatar } from './ui'

export const TABS = ['advisor', 'dining', 'meals', 'profile'] as const
export type Tab = (typeof TABS)[number]

const TAB_META: Record<Tab, { label: string; icon: (p: { size?: number }) => ReactNode }> = {
  advisor: { label: 'Advisor', icon: IconAdvisor },
  dining: { label: 'Dining', icon: IconDining },
  meals: { label: 'My Meals', icon: IconMyMeals },
  profile: { label: 'Profile', icon: IconUser },
}

export function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value)
}

function readHash(): Tab {
  const hash = window.location.hash.replace(/^#\/?/, '')
  return isTab(hash) ? hash : 'advisor'
}

/** Tab state, mirrored into `location.hash` so Back and reload both work. */
export function useTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTabState] = useState<Tab>(readHash)

  useEffect(() => {
    const onHashChange = () => setTabState(readHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const setTab = useCallback((next: Tab) => {
    setTabState(next)
    if (window.location.hash !== `#/${next}`) window.location.hash = `#/${next}`
  }, [])

  return [tab, setTab]
}

export function AppShell({
  tab,
  onTabChange,
  displayName,
  children,
}: {
  tab: Tab
  onTabChange: (tab: Tab) => void
  displayName: string
  children: ReactNode
}) {
  return (
    <div className="shell">
      <header className="app-header">
        <p className="brand">
          <LogoUniBite size={24} label="UniBite" />
          UniBite
        </p>
        <button
          type="button"
          className="avatar-button"
          onClick={() => onTabChange('profile')}
          aria-label="Your profile"
          title="Your profile"
        >
          <Avatar name={displayName} size={34} />
        </button>
      </header>

      <main className="shell-main">{children}</main>

      <nav className="bottom-nav" aria-label="Main">
        {TABS.map((entry) => {
          const { label, icon: Icon } = TAB_META[entry]
          const active = entry === tab
          return (
            <button
              key={entry}
              type="button"
              className={`nav-item${active ? ' active' : ''}`}
              onClick={() => onTabChange(entry)}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={22} />
              <span>{label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
