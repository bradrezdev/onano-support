import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { RoleGuard } from '@/components/layout/RoleGuard'
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import ConversationDetailPage from '@/pages/ConversationDetailPage'
import ContactsPage from '@/pages/ContactsPage'
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
            { path: '/', element: <Navigate to="/inbox" replace /> },
            { path: '/inbox', element: <DashboardPage /> },
            { path: '/inbox/:id', element: <ConversationDetailPage /> },
            { path: '/contacts', element: <ContactsPage /> },
            { path: '/tickets', element: <TicketsPage /> },
            { path: '/tickets/new', element: <TicketNewPage /> },
            { path: '/tickets/:id', element: <TicketDetailPage /> },
            { path: '/pipeline', element: <PipelinePage /> },
            { path: '/users', element: <UsersPage /> },
            { path: '/users/:id', element: <UserDetailPage /> },
            {
              element: <RoleGuard allow={['admin']} />,
              children: [
                { path: '/categories', element: <CategoriesPage /> },
                { path: '/themes', element: <ThemesPage /> },
                { path: '/themes/:id', element: <FlowEditorPage /> },
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