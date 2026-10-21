import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { RoleGuard } from '@/components/layout/RoleGuard'
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import InboxPage from '@/pages/InboxPage'
import ConversationDetailPage from '@/pages/ConversationDetailPage'
import ContactsPage from '@/pages/ContactsPage'
import ContactDetailPage from '@/pages/ContactDetailPage'
import CategoriesPage from '@/pages/CategoriesPage'
import TicketsPage from '@/pages/TicketsPage'
import TicketNewPage from '@/pages/TicketNewPage'
import TicketDetailPage from '@/pages/TicketDetailPage'
import { NotFoundPage, ForbiddenPage } from '@/pages/NotFoundPage'
import ThemesPage from '@/pages/ThemesPage'
import FlowEditorPage from '@/pages/FlowEditorPage'
import PipelinePage from '@/pages/PipelinePage'
import UsersPage from '@/pages/UsersPage'
import UserDetailPage from '@/pages/UserDetailPage'
import AuditPage from '@/pages/AuditPage'
import TrashPage from '@/pages/TrashPage'
import RolesPage from '@/pages/RolesPage'
import RoleColorsPage from '@/pages/RoleColorsPage'
import ProfilePage from '@/pages/ProfilePage'

export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    { path: '/403', element: <ForbiddenPage /> },
    {
      element: <ProtectedRoute />,
      children: [
        {
          element: <AppShell />,
          children: [
            { path: '/', element: <DashboardPage /> },
            { path: '/profile', element: <ProfilePage /> },
            { path: '/inbox', element: <InboxPage /> },
            { path: '/inbox/:id', element: <ConversationDetailPage /> },
            { path: '/contacts', element: <ContactsPage /> },
            { path: '/contacts/:id', element: <ContactDetailPage /> },
            { path: '/tickets', element: <TicketsPage /> },
            { path: '/tickets/new', element: <TicketNewPage /> },
            { path: '/tickets/:id', element: <TicketDetailPage /> },
            { path: '/pipeline', element: <PipelinePage /> },
            { path: '/users', element: <UsersPage /> },
            { path: '/users/:id', element: <UserDetailPage /> },
            {
              // Permission-gated, not admin-gated: a custom role holding any
              // of these keys renders the page (R2).
              element: (
                <RoleGuard
                  allow={[
                    'admin.viewAccounts',
                    'category.create',
                    'theme.create',
                    'admin.viewAudit',
                    'admin.manageRoles',
                    'ticket.delete',
                  ]}
                />
              ),
              children: [
                { path: '/categories', element: <CategoriesPage /> },
                { path: '/themes', element: <ThemesPage /> },
                { path: '/themes/:id', element: <FlowEditorPage /> },
                { path: '/audit', element: <AuditPage /> },
                { path: '/roles', element: <RolesPage /> },
                { path: '/roles/colors', element: <RoleColorsPage /> },
                { path: '/tickets/trash', element: <TrashPage /> },
              ],
            },
          ],
        },
      ],
    },
    { path: '*', element: <NotFoundPage /> },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  },
)