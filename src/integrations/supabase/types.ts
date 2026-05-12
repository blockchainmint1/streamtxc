export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      chain_events: {
        Row: {
          block_hash: string | null
          block_number: number | null
          created_at: string
          event_type: string
          from_wallet: string | null
          id: string
          metadata: Json | null
          op_return_payload: string
          status: string
          to_wallet: string | null
          tx_hash: string
          video_cid: string
          video_wallet: string | null
        }
        Insert: {
          block_hash?: string | null
          block_number?: number | null
          created_at?: string
          event_type: string
          from_wallet?: string | null
          id?: string
          metadata?: Json | null
          op_return_payload: string
          status?: string
          to_wallet?: string | null
          tx_hash: string
          video_cid: string
          video_wallet?: string | null
        }
        Update: {
          block_hash?: string | null
          block_number?: number | null
          created_at?: string
          event_type?: string
          from_wallet?: string | null
          id?: string
          metadata?: Json | null
          op_return_payload?: string
          status?: string
          to_wallet?: string | null
          tx_hash?: string
          video_cid?: string
          video_wallet?: string | null
        }
        Relationships: []
      }
      creator_credits: {
        Row: {
          credits: number
          updated_at: string
          wallet: string
        }
        Insert: {
          credits?: number
          updated_at?: string
          wallet: string
        }
        Update: {
          credits?: number
          updated_at?: string
          wallet?: string
        }
        Relationships: []
      }
      payments: {
        Row: {
          created_at: string
          id: string
          mock_tx_hash: string
          months_prepaid: number
          txc_amount: number
          video_cid: string
          wallet: string
        }
        Insert: {
          created_at?: string
          id?: string
          mock_tx_hash: string
          months_prepaid: number
          txc_amount: number
          video_cid: string
          wallet: string
        }
        Update: {
          created_at?: string
          id?: string
          mock_tx_hash?: string
          months_prepaid?: number
          txc_amount?: number
          video_cid?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_video_cid_fkey"
            columns: ["video_cid"]
            isOneToOne: false
            referencedRelation: "videos"
            referencedColumns: ["cid"]
          },
        ]
      }
      videos: {
        Row: {
          block_hash: string | null
          block_number: number | null
          cid: string
          created_at: string
          derivation_index: number | null
          description: string | null
          duration_s: number | null
          expires_at: string
          mime_type: string | null
          months_prepaid: number
          op_return_payload: string | null
          owner_wallet: string
          paid_at: string | null
          payment_received_txc: number
          payment_required_txc: number | null
          payment_tx_hash: string | null
          size_bytes: number
          status: string
          title: string
          tx_hash: string | null
          unpinned_at: string | null
          video_wallet: string | null
          view_count: number
        }
        Insert: {
          block_hash?: string | null
          block_number?: number | null
          cid: string
          created_at?: string
          derivation_index?: number | null
          description?: string | null
          duration_s?: number | null
          expires_at?: string
          mime_type?: string | null
          months_prepaid?: number
          op_return_payload?: string | null
          owner_wallet: string
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          payment_tx_hash?: string | null
          size_bytes: number
          status?: string
          title: string
          tx_hash?: string | null
          unpinned_at?: string | null
          video_wallet?: string | null
          view_count?: number
        }
        Update: {
          block_hash?: string | null
          block_number?: number | null
          cid?: string
          created_at?: string
          derivation_index?: number | null
          description?: string | null
          duration_s?: number | null
          expires_at?: string
          mime_type?: string | null
          months_prepaid?: number
          op_return_payload?: string | null
          owner_wallet?: string
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          payment_tx_hash?: string | null
          size_bytes?: number
          status?: string
          title?: string
          tx_hash?: string | null
          unpinned_at?: string | null
          video_wallet?: string | null
          view_count?: number
        }
        Relationships: []
      }
      view_events: {
        Row: {
          id: number
          ip_hash: string
          ts: string
          video_cid: string
        }
        Insert: {
          id?: number
          ip_hash: string
          ts?: string
          video_cid: string
        }
        Update: {
          id?: number
          ip_hash?: string
          ts?: string
          video_cid?: string
        }
        Relationships: [
          {
            foreignKeyName: "view_events_video_cid_fkey"
            columns: ["video_cid"]
            isOneToOne: false
            referencedRelation: "videos"
            referencedColumns: ["cid"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      next_video_wallet_index: { Args: never; Returns: number }
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
