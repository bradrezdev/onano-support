import { describe, it, expect } from 'vitest'
import { can, isAdmin, isSupervisorOrAbove, type Action } from './permissions'

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

  it('supervisor can NOT close or reopen tickets', () => {
    expect(can('supervisor', 'ticket.close')).toBe(false)
    expect(can('supervisor', 'ticket.reopen')).toBe(false)
  })

  it('supervisor can NOT create/delete themes', () => {
    expect(can('supervisor', 'theme.create')).toBe(false)
    expect(can('supervisor', 'theme.delete')).toBe(false)
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
