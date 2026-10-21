import { describe, it, expect } from 'vitest'
import {
  can,
  canPermission,
  canWith,
  isAdmin,
  isSupervisorOrAbove,
  type Action,
  type Permission,
} from './permissions'

describe('can', () => {
  it('returns false for null/undefined role', () => {
    expect(can(null, 'ticket.create')).toBe(false)
    expect(can(undefined, 'ticket.create')).toBe(false)
  })

  it('admin can do everything', () => {
    const allActions: Action[] = [
      'admin.createUser',
      'admin.suspendUser',
      'admin.deleteUser',
      'admin.assignRole',
      'category.create',
      'category.update',
      'category.delete',
      'subcategory.create',
      'subcategory.delete',
      'theme.create',
      'theme.delete',
      'flow.create',
      'flow.delete',
      'ticket.create',
      'ticket.assign',
      'ticket.close',
      'ticket.reopen',
      'ticket.moveFlow',
      'ticket.reply',
      'conversation.read',
      'conversation.assign',
      'conversation.reassign',
    ]
    for (const a of allActions) {
      expect(can('admin', a)).toBe(true)
    }
  })

  it('supervisor CAN close and reopen tickets (T4)', () => {
    expect(can('supervisor', 'ticket.close')).toBe(true)
    expect(can('supervisor', 'ticket.reopen')).toBe(true)
  })

  it('supervisor CAN create themes but NOT delete them (P1)', () => {
    expect(can('supervisor', 'theme.create')).toBe(true)
    expect(can('supervisor', 'theme.delete')).toBe(false)
  })

  it('supervisor can NOT delete tickets or manage accounts', () => {
    expect(can('supervisor', 'ticket.delete')).toBe(false)
    expect(can('supervisor', 'admin.viewAccounts')).toBe(false)
    expect(can('supervisor', 'admin.viewAudit')).toBe(false)
    expect(can('supervisor', 'admin.manageRoles')).toBe(false)
  })

  it('supervisor CAN move tickets between flows and assign them', () => {
    expect(can('supervisor', 'ticket.moveFlow')).toBe(true)
    expect(can('supervisor', 'ticket.assign')).toBe(true)
  })

  it('soporte can only create/reply tickets and read conversations', () => {
    expect(can('soporte', 'ticket.create')).toBe(true)
    expect(can('soporte', 'ticket.reply')).toBe(true)
    expect(can('soporte', 'conversation.read')).toBe(true)
    expect(can('soporte', 'conversation.assign')).toBe(true)
    expect(can('soporte', 'ticket.close')).toBe(false)
    expect(can('soporte', 'ticket.moveFlow')).toBe(false)
    expect(can('soporte', 'category.create')).toBe(false)
    expect(can('soporte', 'theme.create')).toBe(false)
  })

  it('no role can administer users except admin', () => {
    expect(can('supervisor', 'admin.createUser')).toBe(false)
    expect(can('soporte', 'admin.createUser')).toBe(false)
    expect(can('admin', 'admin.createUser')).toBe(true)
  })
})

describe('isAdmin', () => {
  it('matches only admin', () => {
    expect(isAdmin('admin')).toBe(true)
    expect(isAdmin('supervisor')).toBe(false)
    expect(isAdmin('soporte')).toBe(false)
    expect(isAdmin(null)).toBe(false)
    expect(isAdmin(undefined)).toBe(false)
  })
})

describe('isSupervisorOrAbove', () => {
  it('matches admin and supervisor but not soporte', () => {
    expect(isSupervisorOrAbove('admin')).toBe(true)
    expect(isSupervisorOrAbove('supervisor')).toBe(true)
    expect(isSupervisorOrAbove('soporte')).toBe(false)
    expect(isSupervisorOrAbove(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canPermission — the real check, reading the server-resolved keyring (R2)
// ---------------------------------------------------------------------------

describe('canPermission', () => {
  it('grants only what the keyring lists', () => {
    const auditor: Permission[] = ['ticket.reply', 'admin.viewAudit']
    expect(canPermission(auditor, 'ticket.reply')).toBe(true)
    expect(canPermission(auditor, 'admin.viewAudit')).toBe(true)
    expect(canPermission(auditor, 'ticket.delete')).toBe(false)
    expect(canPermission(auditor, 'admin.assignRole')).toBe(false)
  })

  it('denies everything for an empty keyring', () => {
    // The blank-badge case: a role with no keys can do nothing.
    expect(canPermission([], 'ticket.reply')).toBe(false)
  })

  it('denies everything for null/undefined', () => {
    expect(canPermission(null, 'ticket.reply')).toBe(false)
    expect(canPermission(undefined, 'ticket.reply')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canWith — picks the keyring when present, shipped fallback otherwise
// ---------------------------------------------------------------------------

describe('canWith', () => {
  it('prefers the server keyring over the shipped fallback', () => {
    // A custom role with no permissions but a legacy admin column: the
    // keyring wins, so it cannot act like an admin.
    expect(
      canWith({ role: 'admin', permissions: [] }, 'ticket.delete'),
    ).toBe(false)
  })

  it('falls back to the shipped matrix only when no keyring arrived yet', () => {
    // permissions === undefined means /api/me has not resolved. Once it has,
    // even an empty array is an authoritative "holds nothing".
    expect(canWith({ role: 'supervisor' }, 'ticket.close')).toBe(true)
    expect(canWith({ role: 'soporte' }, 'ticket.close')).toBe(false)
  })

  it('treats an empty keyring as "holds nothing", never as the fallback', () => {
    expect(canWith({ role: 'admin', permissions: [] }, 'ticket.create')).toBe(false)
    expect(canWith({ role: 'admin', permissions: [] }, 'conversation.read')).toBe(false)
  })

  it('uses the keyring when it is non-empty', () => {
    expect(
      canWith({ role: 'soporte', permissions: ['ticket.close'] }, 'ticket.close'),
    ).toBe(true)
  })

  it('denies for a null profile', () => {
    expect(canWith(null, 'ticket.create')).toBe(false)
    expect(canWith(undefined, 'ticket.create')).toBe(false)
  })
})
