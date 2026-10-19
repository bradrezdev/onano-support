export interface Theme {
  id: string
  name: string
  description: string | null
  color: string
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface Flow {
  id: string
  theme_id: string
  name: string
  description: string | null
  position: number
  is_terminal: boolean
  created_at: string
  updated_at: string
}

export interface ThemeWithFlows extends Theme {
  flows: Flow[]
}