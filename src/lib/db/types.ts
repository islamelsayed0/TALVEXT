// GENERATED FILE. Do not edit by hand.
// Regenerate after every migration, with the local stack running:
//   npx supabase db reset && npx supabase gen types typescript --local --schema public
// (or the Supabase MCP tool generate_typescript_types against project
// rdfuzadtraxzrrthhnnp). Then re-append the convenience aliases at the bottom.
// Source of truth is the schema in supabase/migrations/.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      api_key_events: {
        Row: {
          actor: string
          event_type: string
          id: string
          key_last_four: string
          occurred_at: string
          org_id: string
          provider: string
        }
        Insert: {
          actor: string
          event_type: string
          id?: string
          key_last_four: string
          occurred_at?: string
          org_id: string
          provider: string
        }
        Update: {
          actor?: string
          event_type?: string
          id?: string
          key_last_four?: string
          occurred_at?: string
          org_id?: string
          provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_key_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      articles: {
        Row: {
          audience_tags: string[]
          body: string
          category: string | null
          created_at: string
          created_by: string
          id: string
          org_id: string
          published_at: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          audience_tags?: string[]
          body: string
          category?: string | null
          created_at?: string
          created_by: string
          id?: string
          org_id: string
          published_at?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          audience_tags?: string[]
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string
          id?: string
          org_id?: string
          published_at?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "articles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor: string | null
          detail: Json
          id: string
          occurred_at: string
          org_id: string
        }
        Insert: {
          action: string
          actor?: string | null
          detail?: Json
          id?: string
          occurred_at?: string
          org_id: string
        }
        Update: {
          action?: string
          actor?: string | null
          detail?: Json
          id?: string
          occurred_at?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_conversations: {
        Row: {
          created_at: string
          created_by: string
          id: string
          org_id: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          org_id: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          org_id?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          grounded_article_ids: Json | null
          id: string
          input_tokens: number | null
          key_source: string | null
          model: string | null
          org_id: string
          output_tokens: number | null
          provider: string | null
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          grounded_article_ids?: Json | null
          id?: string
          input_tokens?: number | null
          key_source?: string | null
          model?: string | null
          org_id: string
          output_tokens?: number | null
          provider?: string | null
          role: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          grounded_article_ids?: Json | null
          id?: string
          input_tokens?: number | null
          key_source?: string | null
          model?: string | null
          org_id?: string
          output_tokens?: number | null
          provider?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      incident_events: {
        Row: {
          check_id: string | null
          detail: string | null
          event_type: string
          id: string
          incident_id: string
          occurred_at: string
          org_id: string
        }
        Insert: {
          check_id?: string | null
          detail?: string | null
          event_type: string
          id?: string
          incident_id: string
          occurred_at: string
          org_id: string
        }
        Update: {
          check_id?: string | null
          detail?: string | null
          event_type?: string
          id?: string
          incident_id?: string
          occurred_at?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incident_events_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "monitor_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incident_events_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incident_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          created_at: string
          id: string
          last_notified_at: string | null
          last_reopened_at: string | null
          monitor_id: string
          opened_at: string
          org_id: string
          resolved_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_notified_at?: string | null
          last_reopened_at?: string | null
          monitor_id: string
          opened_at: string
          org_id: string
          resolved_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_notified_at?: string | null
          last_reopened_at?: string | null
          monitor_id?: string
          opened_at?: string
          org_id?: string
          resolved_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "incidents_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          buy_url: string | null
          created_at: string
          id: string
          item_number: string | null
          location: string | null
          min_stock: number
          name: string
          notes: string | null
          org_id: string
          quantity: number
          serial_number: string | null
          updated_at: string
        }
        Insert: {
          buy_url?: string | null
          created_at?: string
          id?: string
          item_number?: string | null
          location?: string | null
          min_stock?: number
          name: string
          notes?: string | null
          org_id: string
          quantity?: number
          serial_number?: string | null
          updated_at?: string
        }
        Update: {
          buy_url?: string | null
          created_at?: string
          id?: string
          item_number?: string | null
          location?: string | null
          min_stock?: number
          name?: string
          notes?: string | null
          org_id?: string
          quantity?: number
          serial_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      monitor_checks: {
        Row: {
          checked_at: string
          error_message: string | null
          id: string
          monitor_id: string
          org_id: string
          response_time_ms: number | null
          status: string
        }
        Insert: {
          checked_at?: string
          error_message?: string | null
          id?: string
          monitor_id: string
          org_id: string
          response_time_ms?: number | null
          status: string
        }
        Update: {
          checked_at?: string
          error_message?: string | null
          id?: string
          monitor_id?: string
          org_id?: string
          response_time_ms?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitor_checks_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monitor_checks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      monitor_daily_rollups: {
        Row: {
          avg_response_ms: number | null
          check_count: number
          day: string
          max_response_ms: number | null
          min_response_ms: number | null
          monitor_id: string
          org_id: string
          uptime_percent: number
        }
        Insert: {
          avg_response_ms?: number | null
          check_count: number
          day: string
          max_response_ms?: number | null
          min_response_ms?: number | null
          monitor_id: string
          org_id: string
          uptime_percent: number
        }
        Update: {
          avg_response_ms?: number | null
          check_count?: number
          day?: string
          max_response_ms?: number | null
          min_response_ms?: number | null
          monitor_id?: string
          org_id?: string
          uptime_percent?: number
        }
        Relationships: [
          {
            foreignKeyName: "monitor_daily_rollups_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "monitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monitor_daily_rollups_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      monitors: {
        Row: {
          active: boolean
          cert_alerted_threshold: string | null
          cert_expires_at: string | null
          created_at: string
          failing_since: string | null
          id: string
          interval_seconds: number
          last_checked_at: string | null
          last_status: string | null
          name: string
          org_id: string
          suppress_set_at: string | null
          suppress_until: string | null
          updated_at: string
          url: string
        }
        Insert: {
          active?: boolean
          cert_alerted_threshold?: string | null
          cert_expires_at?: string | null
          created_at?: string
          failing_since?: string | null
          id?: string
          interval_seconds?: number
          last_checked_at?: string | null
          last_status?: string | null
          name: string
          org_id: string
          suppress_set_at?: string | null
          suppress_until?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          active?: boolean
          cert_alerted_threshold?: string | null
          cert_expires_at?: string | null
          created_at?: string
          failing_since?: string | null
          id?: string
          interval_seconds?: number
          last_checked_at?: string | null
          last_status?: string | null
          name?: string
          org_id?: string
          suppress_set_at?: string | null
          suppress_until?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_api_keys: {
        Row: {
          added_by: string
          created_at: string
          encrypted_key: string
          id: string
          key_last_four: string
          org_id: string
          provider: string
          updated_at: string
        }
        Insert: {
          added_by: string
          created_at?: string
          encrypted_key: string
          id?: string
          key_last_four: string
          org_id: string
          provider: string
          updated_at?: string
        }
        Update: {
          added_by?: string
          created_at?: string
          encrypted_key?: string
          id?: string
          key_last_four?: string
          org_id?: string
          provider?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_api_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_billing: {
        Row: {
          ai_addon: boolean
          ai_answers_included: number
          cancel_at_period_end: boolean
          clickwrap_accepted_at: string | null
          clickwrap_terms_version: string | null
          created_at: string
          current_period_end: string | null
          monitor_limit: number | null
          org_id: string
          org_limit: number
          plan: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          ai_addon?: boolean
          ai_answers_included?: number
          cancel_at_period_end?: boolean
          clickwrap_accepted_at?: string | null
          clickwrap_terms_version?: string | null
          created_at?: string
          current_period_end?: string | null
          monitor_limit?: number | null
          org_id: string
          org_limit?: number
          plan?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          ai_addon?: boolean
          ai_answers_included?: number
          cancel_at_period_end?: boolean
          clickwrap_accepted_at?: string | null
          clickwrap_terms_version?: string | null
          created_at?: string
          current_period_end?: string | null
          monitor_limit?: number | null
          org_id?: string
          org_limit?: number
          plan?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_billing_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          clerk_user_id: string
          created_at: string
          org_id: string
          role: string
          tags: string[]
        }
        Insert: {
          clerk_user_id: string
          created_at?: string
          org_id: string
          role: string
          tags?: string[]
        }
        Update: {
          clerk_user_id?: string
          created_at?: string
          org_id?: string
          role?: string
          tags?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_notification_settings: {
        Row: {
          alert_cooldown_minutes: number
          created_at: string
          digest_enabled: boolean
          digest_last_sent_on: string | null
          digest_send_time: string
          discord_webhook: string | null
          email_on_open: boolean
          email_on_resolve: boolean
          notification_email: string | null
          org_id: string
          updated_at: string
        }
        Insert: {
          alert_cooldown_minutes?: number
          created_at?: string
          digest_enabled?: boolean
          digest_last_sent_on?: string | null
          digest_send_time?: string
          discord_webhook?: string | null
          email_on_open?: boolean
          email_on_resolve?: boolean
          notification_email?: string | null
          org_id: string
          updated_at?: string
        }
        Update: {
          alert_cooldown_minutes?: number
          created_at?: string
          digest_enabled?: boolean
          digest_last_sent_on?: string | null
          digest_send_time?: string
          discord_webhook?: string | null
          email_on_open?: boolean
          email_on_resolve?: boolean
          notification_email?: string | null
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_notification_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          clerk_org_id: string
          created_at: string
          id: string
          name: string
          status_page_enabled: boolean
          status_page_slug: string | null
          timezone: string | null
        }
        Insert: {
          clerk_org_id: string
          created_at?: string
          id?: string
          name: string
          status_page_enabled?: boolean
          status_page_slug?: string | null
          timezone?: string | null
        }
        Update: {
          clerk_org_id?: string
          created_at?: string
          id?: string
          name?: string
          status_page_enabled?: boolean
          status_page_slug?: string | null
          timezone?: string | null
        }
        Relationships: []
      }
      platform_heartbeat: {
        Row: {
          duration_ms: number
          id: string
          last_run_at: string | null
          last_success_at: string | null
          run_count: number
          step_failures: number
          updated_at: string
        }
        Insert: {
          duration_ms?: number
          id?: string
          last_run_at?: string | null
          last_success_at?: string | null
          run_count?: number
          step_failures?: number
          updated_at?: string
        }
        Update: {
          duration_ms?: number
          id?: string
          last_run_at?: string | null
          last_success_at?: string | null
          run_count?: number
          step_failures?: number
          updated_at?: string
        }
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          processed_at: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id: string
          processed_at?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          processed_at?: string | null
        }
        Relationships: []
      }
      ticket_comments: {
        Row: {
          author: string
          body: string
          created_at: string
          id: string
          is_internal: boolean
          org_id: string
          ticket_id: string
        }
        Insert: {
          author: string
          body: string
          created_at?: string
          id?: string
          is_internal?: boolean
          org_id: string
          ticket_id: string
        }
        Update: {
          author?: string
          body?: string
          created_at?: string
          id?: string
          is_internal?: boolean
          org_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_comments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_comments_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_events: {
        Row: {
          actor: string | null
          detail: string | null
          event_type: string
          id: string
          occurred_at: string
          org_id: string
          ticket_id: string
        }
        Insert: {
          actor?: string | null
          detail?: string | null
          event_type: string
          id?: string
          occurred_at?: string
          org_id: string
          ticket_id: string
        }
        Update: {
          actor?: string | null
          detail?: string | null
          event_type?: string
          id?: string
          occurred_at?: string
          org_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_events_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          conversation_id: string | null
          created_at: string
          description: string
          hidden_by_requester: boolean
          id: string
          incident_id: string | null
          org_id: string
          resolved_at: string | null
          status: string
          submitted_by: string
          title: string
          updated_at: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          description: string
          hidden_by_requester?: boolean
          id?: string
          incident_id?: string | null
          org_id: string
          resolved_at?: string | null
          status?: string
          submitted_by: string
          title: string
          updated_at?: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          description?: string
          hidden_by_requester?: boolean
          id?: string
          incident_id?: string | null
          org_id?: string
          resolved_at?: string | null
          status?: string
          submitted_by?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      clerk_active_org_id: { Args: never; Returns: string }
      clerk_is_org_admin: { Args: never; Returns: boolean }
      clerk_user_id: { Args: never; Returns: string }
      inventory_access_gate: { Args: never; Returns: boolean }
      is_org_admin: { Args: { p_org_id: string }; Returns: boolean }
      member_audience_tags: { Args: never; Returns: string[] }
      member_hide_ticket: { Args: { p_ticket_id: string }; Returns: undefined }
      member_set_ticket_status: {
        Args: { p_explanation?: string; p_status: string; p_ticket_id: string }
        Returns: undefined
      }
      org_api_key_providers: { Args: never; Returns: string[] }
      org_has_api_key: { Args: never; Returns: boolean }
      status_page_is_public: { Args: { p_org_id: string }; Returns: boolean }
      upsert_monitor_daily_rollups: {
        Args: { p_day: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const


// Convenience aliases used by the data layer.
export type Organization = Tables<"organizations">
export type OrgMember = Tables<"org_members">
export type OrgMemberRole = "owner" | "admin" | "technician" | "member"
export type Monitor = Tables<"monitors">
export type MonitorCheck = Tables<"monitor_checks">
export type MonitorDailyRollup = Tables<"monitor_daily_rollups">
/** Check outcome as stored. The UI adds "pending" for never checked monitors. */
export type MonitorStatus = "up" | "down"
export type Incident = Tables<"incidents">
export type IncidentEvent = Tables<"incident_events">
export type IncidentStatus = "open" | "resolved"
export type IncidentEventType = "opened" | "reopened" | "recovered" | "resolved"
export type Ticket = Tables<"tickets">
export type TicketComment = Tables<"ticket_comments">
export type TicketEvent = Tables<"ticket_events">
export type TicketStatus = "open" | "in_progress" | "resolved" | "canceled"
/** The two states a ticket ends in. Neither is locked: an admin can move a
 * ticket out of either, and a requester can reopen a resolved one. */
export type TerminalTicketStatus = Extract<
  TicketStatus,
  "resolved" | "canceled"
>
export type TicketEventType =
  | "created"
  | "status_changed"
  // Written only by the retired 7 day auto close sweep (migration 019). No
  // code produces these any more; historical rows keep rendering.
  | "auto_closed"
  | "created_from_incident"
  | "created_from_chat"
// BYOK vault and AI support chat (Task 5).
export type OrgApiKey = Tables<"org_api_keys">
export type ApiKeyEvent = Tables<"api_key_events">
export type ApiKeyEventType = "added" | "replaced" | "deleted"
/** The AI providers an org may bring a key for. One active per provider. */
export type AiProvider = "anthropic" | "openai" | "google"
// Notifications (F10).
export type OrgNotificationSettings = Tables<"org_notification_settings">
export type ChatConversation = Tables<"chat_conversations">
export type ChatMessage = Tables<"chat_messages">
export type ChatConversationStatus = "open" | "resolved" | "escalated"
export type ChatRole = "user" | "assistant"
// Audit log (F12).
export type AuditEntry = Tables<"audit_log">
export type AuditAction =
  | "member_role_changed"
  | "api_key_added"
  | "api_key_replaced"
  | "api_key_deleted"
  | "monitor_deleted"
  | "status_page_enabled"
  | "status_page_disabled"
  | "status_page_slug_changed"
  | "timezone_changed"
  | "notification_settings_changed"
  | "article_created"
  | "article_published"
  | "article_unpublished"
  | "article_updated"
  | "article_deleted"
  | "member_tags_changed"
  | "inventory_item_created"
  | "inventory_item_updated"
  | "inventory_item_deleted"
  | "ticket_status_changed"
  | "ticket_canceled"
  | "ticket_reopened"
// Knowledge base (F14).
export type Article = Tables<"articles">
export type ArticleStatus = "draft" | "published"
// Inventory (F15).
export type InventoryItem = Tables<"inventory_items">

// The sweep heartbeat. Platform state, one row, not scoped to any org.
export type PlatformHeartbeat = Tables<"platform_heartbeat">

// Billing (F13).
export type OrgBilling = Tables<"org_billing">
export type StripeWebhookEvent = Tables<"stripe_webhook_events">
