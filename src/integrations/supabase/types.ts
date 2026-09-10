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
      bug_reports: {
        Row: {
          attachment_data_url: string | null
          attachment_name: string | null
          attachment_type: string | null
          created_at: string
          details: string
          email: string | null
          id: string
          name: string | null
          page_url: string | null
          reporter_wallet: string | null
          telegram: string | null
          user_agent: string | null
        }
        Insert: {
          attachment_data_url?: string | null
          attachment_name?: string | null
          attachment_type?: string | null
          created_at?: string
          details: string
          email?: string | null
          id?: string
          name?: string | null
          page_url?: string | null
          reporter_wallet?: string | null
          telegram?: string | null
          user_agent?: string | null
        }
        Update: {
          attachment_data_url?: string | null
          attachment_name?: string | null
          attachment_type?: string | null
          created_at?: string
          details?: string
          email?: string | null
          id?: string
          name?: string | null
          page_url?: string | null
          reporter_wallet?: string | null
          telegram?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
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
      comment_boosts: {
        Row: {
          amount_txc: number
          booster_wallet: string | null
          comment_id: string
          created_at: string
          deposit_wallet: string | null
          derivation_index: number | null
          id: string
          mock_tx_hash: string | null
          op_return_payload: string | null
          paid_at: string | null
          payment_received_txc: number
          payment_required_txc: number | null
          pending_expires_at: string | null
          status: string
          tx_hash: string | null
        }
        Insert: {
          amount_txc: number
          booster_wallet?: string | null
          comment_id: string
          created_at?: string
          deposit_wallet?: string | null
          derivation_index?: number | null
          id?: string
          mock_tx_hash?: string | null
          op_return_payload?: string | null
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          pending_expires_at?: string | null
          status?: string
          tx_hash?: string | null
        }
        Update: {
          amount_txc?: number
          booster_wallet?: string | null
          comment_id?: string
          created_at?: string
          deposit_wallet?: string | null
          derivation_index?: number | null
          id?: string
          mock_tx_hash?: string | null
          op_return_payload?: string | null
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          pending_expires_at?: string | null
          status?: string
          tx_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comment_boosts_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          body: string
          body_hash: string | null
          boost_total_txc: number
          chunk_tx_hashes: string[] | null
          comment_cid: string | null
          commenter_wallet: string | null
          created_at: string
          creator_payout_tx_hash: string | null
          creator_share_txc: number
          deposit_wallet: string | null
          derivation_index: number | null
          hidden_at: string | null
          hidden_reason: string | null
          hosting_payout_tx_hash: string | null
          hosting_share_txc: number
          id: string
          initial_payment_txc: number
          last_boost_at: string
          mock_tx_hash: string | null
          op_return_payload: string | null
          paid_at: string | null
          payment_received_txc: number
          payment_required_txc: number | null
          payout_attempted_at: string | null
          payout_status: string
          pending_expires_at: string | null
          platform_payout_tx_hash: string | null
          platform_share_txc: number
          status: string
          tx_hash: string | null
          video_cid: string
        }
        Insert: {
          body: string
          body_hash?: string | null
          boost_total_txc?: number
          chunk_tx_hashes?: string[] | null
          comment_cid?: string | null
          commenter_wallet?: string | null
          created_at?: string
          creator_payout_tx_hash?: string | null
          creator_share_txc?: number
          deposit_wallet?: string | null
          derivation_index?: number | null
          hidden_at?: string | null
          hidden_reason?: string | null
          hosting_payout_tx_hash?: string | null
          hosting_share_txc?: number
          id?: string
          initial_payment_txc: number
          last_boost_at?: string
          mock_tx_hash?: string | null
          op_return_payload?: string | null
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          payout_attempted_at?: string | null
          payout_status?: string
          pending_expires_at?: string | null
          platform_payout_tx_hash?: string | null
          platform_share_txc?: number
          status?: string
          tx_hash?: string | null
          video_cid: string
        }
        Update: {
          body?: string
          body_hash?: string | null
          boost_total_txc?: number
          chunk_tx_hashes?: string[] | null
          comment_cid?: string | null
          commenter_wallet?: string | null
          created_at?: string
          creator_payout_tx_hash?: string | null
          creator_share_txc?: number
          deposit_wallet?: string | null
          derivation_index?: number | null
          hidden_at?: string | null
          hidden_reason?: string | null
          hosting_payout_tx_hash?: string | null
          hosting_share_txc?: number
          id?: string
          initial_payment_txc?: number
          last_boost_at?: string
          mock_tx_hash?: string | null
          op_return_payload?: string | null
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          payout_attempted_at?: string | null
          payout_status?: string
          pending_expires_at?: string | null
          platform_payout_tx_hash?: string | null
          platform_share_txc?: number
          status?: string
          tx_hash?: string | null
          video_cid?: string
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
      imports: {
        Row: {
          bytes_total: number | null
          bytes_uploaded: number
          cid: string | null
          created_at: string
          error_message: string | null
          filename: string
          id: string
          source: string
          source_url: string
          status: string
          updated_at: string
        }
        Insert: {
          bytes_total?: number | null
          bytes_uploaded?: number
          cid?: string | null
          created_at?: string
          error_message?: string | null
          filename: string
          id?: string
          source: string
          source_url: string
          status?: string
          updated_at?: string
        }
        Update: {
          bytes_total?: number | null
          bytes_uploaded?: number
          cid?: string | null
          created_at?: string
          error_message?: string | null
          filename?: string
          id?: string
          source?: string
          source_url?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      live_channels: {
        Row: {
          archive_prefix: string
          created_at: string
          hls_url: string
          id: string
          last_used_at: string | null
          medialive_channel_id: string
          medialive_input_id: string
          mediapackage_channel_id: string
          mediapackage_endpoint_id: string | null
          owner_wallet: string
          provisioned_at: string
          rtmp_url: string
          status: string
          stream_key: string
          updated_at: string
        }
        Insert: {
          archive_prefix: string
          created_at?: string
          hls_url: string
          id?: string
          last_used_at?: string | null
          medialive_channel_id: string
          medialive_input_id: string
          mediapackage_channel_id: string
          mediapackage_endpoint_id?: string | null
          owner_wallet: string
          provisioned_at?: string
          rtmp_url: string
          status?: string
          stream_key: string
          updated_at?: string
        }
        Update: {
          archive_prefix?: string
          created_at?: string
          hls_url?: string
          id?: string
          last_used_at?: string | null
          medialive_channel_id?: string
          medialive_input_id?: string
          mediapackage_channel_id?: string
          mediapackage_endpoint_id?: string | null
          owner_wallet?: string
          provisioned_at?: string
          rtmp_url?: string
          status?: string
          stream_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      live_chat_messages: {
        Row: {
          body: string
          created_at: string
          display_name: string | null
          id: string
          stream_id: string
          wallet: string | null
        }
        Insert: {
          body: string
          created_at?: string
          display_name?: string | null
          id?: string
          stream_id: string
          wallet?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          display_name?: string | null
          id?: string
          stream_id?: string
          wallet?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "live_chat_messages_stream_id_fkey"
            columns: ["stream_id"]
            isOneToOne: false
            referencedRelation: "live_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      live_credit_ledger: {
        Row: {
          created_at: string
          delta_txc: number
          id: string
          kind: string
          note: string | null
          stream_id: string | null
          txid: string | null
          wallet: string
        }
        Insert: {
          created_at?: string
          delta_txc: number
          id?: string
          kind: string
          note?: string | null
          stream_id?: string | null
          txid?: string | null
          wallet: string
        }
        Update: {
          created_at?: string
          delta_txc?: number
          id?: string
          kind?: string
          note?: string | null
          stream_id?: string | null
          txid?: string | null
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_credit_ledger_stream_id_fkey"
            columns: ["stream_id"]
            isOneToOne: false
            referencedRelation: "live_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      live_streams: {
        Row: {
          archive_error: string | null
          archive_output_prefix: string | null
          archive_status: string | null
          archive_transcode_job_id: string | null
          archive_video_cid: string | null
          channel_row_id: string | null
          created_at: string
          description: string | null
          ended_at: string | null
          hls_url: string | null
          id: string
          medialive_channel_id: string | null
          owner_wallet: string
          peak_viewers: number
          scheduled_for: string | null
          simulcast_facebook_url: string | null
          simulcast_twitter_url: string | null
          simulcast_youtube_url: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["live_stream_status"]
          stopped_reason: string | null
          thumbnail_cid: string | null
          title: string
          total_views: number
          updated_at: string
        }
        Insert: {
          archive_error?: string | null
          archive_output_prefix?: string | null
          archive_status?: string | null
          archive_transcode_job_id?: string | null
          archive_video_cid?: string | null
          channel_row_id?: string | null
          created_at?: string
          description?: string | null
          ended_at?: string | null
          hls_url?: string | null
          id?: string
          medialive_channel_id?: string | null
          owner_wallet: string
          peak_viewers?: number
          scheduled_for?: string | null
          simulcast_facebook_url?: string | null
          simulcast_twitter_url?: string | null
          simulcast_youtube_url?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["live_stream_status"]
          stopped_reason?: string | null
          thumbnail_cid?: string | null
          title: string
          total_views?: number
          updated_at?: string
        }
        Update: {
          archive_error?: string | null
          archive_output_prefix?: string | null
          archive_status?: string | null
          archive_transcode_job_id?: string | null
          archive_video_cid?: string | null
          channel_row_id?: string | null
          created_at?: string
          description?: string | null
          ended_at?: string | null
          hls_url?: string | null
          id?: string
          medialive_channel_id?: string | null
          owner_wallet?: string
          peak_viewers?: number
          scheduled_for?: string | null
          simulcast_facebook_url?: string | null
          simulcast_twitter_url?: string | null
          simulcast_youtube_url?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["live_stream_status"]
          stopped_reason?: string | null
          thumbnail_cid?: string | null
          title?: string
          total_views?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_streams_channel_row_id_fkey"
            columns: ["channel_row_id"]
            isOneToOne: false
            referencedRelation: "live_channels"
            referencedColumns: ["id"]
          },
        ]
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
      video_drafts: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_nsfw: boolean
          owner_token: string
          thumbnail_cid: string | null
          title: string
          updated_at: string
          wallet: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_nsfw?: boolean
          owner_token: string
          thumbnail_cid?: string | null
          title?: string
          updated_at?: string
          wallet?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_nsfw?: boolean
          owner_token?: string
          thumbnail_cid?: string | null
          title?: string
          updated_at?: string
          wallet?: string | null
        }
        Relationships: []
      }
      video_reports: {
        Row: {
          created_at: string
          details: string | null
          id: string
          reason: string
          reporter_ip_hash: string
          reviewed_at: string | null
          reviewer_note: string | null
          status: string
          video_cid: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          id?: string
          reason: string
          reporter_ip_hash: string
          reviewed_at?: string | null
          reviewer_note?: string | null
          status?: string
          video_cid: string
        }
        Update: {
          created_at?: string
          details?: string | null
          id?: string
          reason?: string
          reporter_ip_hash?: string
          reviewed_at?: string | null
          reviewer_note?: string | null
          status?: string
          video_cid?: string
        }
        Relationships: []
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
          escrowed_creator_txc: number
          expires_at: string
          expiring_at: string | null
          flagged_at: string | null
          flagged_reason: string | null
          hidden_at: string | null
          hidden_reason: string | null
          hls_cid: string | null
          hosting_credit_txc: number
          is_nsfw: boolean
          live_stream_id: string | null
          metadata_cid: string | null
          mime_type: string | null
          months_prepaid: number
          notified_expiring_at: string | null
          notified_pre_expiry_at: string | null
          notified_unpinned_at: string | null
          op_return_payload: string | null
          owner_nonce: string | null
          owner_proof_status: string
          owner_signature: string | null
          owner_verified_at: string | null
          owner_wallet: string | null
          ownership_tx_hash: string | null
          paid_at: string | null
          payment_received_txc: number
          payment_required_txc: number | null
          payment_tx_hash: string | null
          renditions: Json | null
          report_count: number
          size_bytes: number
          source: string
          source_kind: string | null
          status: string
          thumbnail_cid: string | null
          title: string
          transcode_completed_at: string | null
          transcode_error: string | null
          transcode_job_id: string | null
          transcode_started_at: string | null
          transcode_status: string | null
          transcript_cid: string | null
          transcript_text: string | null
          tx_hash: string | null
          unpin_after: string | null
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
          escrowed_creator_txc?: number
          expires_at?: string
          expiring_at?: string | null
          flagged_at?: string | null
          flagged_reason?: string | null
          hidden_at?: string | null
          hidden_reason?: string | null
          hls_cid?: string | null
          hosting_credit_txc?: number
          is_nsfw?: boolean
          live_stream_id?: string | null
          metadata_cid?: string | null
          mime_type?: string | null
          months_prepaid?: number
          notified_expiring_at?: string | null
          notified_pre_expiry_at?: string | null
          notified_unpinned_at?: string | null
          op_return_payload?: string | null
          owner_nonce?: string | null
          owner_proof_status?: string
          owner_signature?: string | null
          owner_verified_at?: string | null
          owner_wallet?: string | null
          ownership_tx_hash?: string | null
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          payment_tx_hash?: string | null
          renditions?: Json | null
          report_count?: number
          size_bytes: number
          source?: string
          source_kind?: string | null
          status?: string
          thumbnail_cid?: string | null
          title: string
          transcode_completed_at?: string | null
          transcode_error?: string | null
          transcode_job_id?: string | null
          transcode_started_at?: string | null
          transcode_status?: string | null
          transcript_cid?: string | null
          transcript_text?: string | null
          tx_hash?: string | null
          unpin_after?: string | null
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
          escrowed_creator_txc?: number
          expires_at?: string
          expiring_at?: string | null
          flagged_at?: string | null
          flagged_reason?: string | null
          hidden_at?: string | null
          hidden_reason?: string | null
          hls_cid?: string | null
          hosting_credit_txc?: number
          is_nsfw?: boolean
          live_stream_id?: string | null
          metadata_cid?: string | null
          mime_type?: string | null
          months_prepaid?: number
          notified_expiring_at?: string | null
          notified_pre_expiry_at?: string | null
          notified_unpinned_at?: string | null
          op_return_payload?: string | null
          owner_nonce?: string | null
          owner_proof_status?: string
          owner_signature?: string | null
          owner_verified_at?: string | null
          owner_wallet?: string | null
          ownership_tx_hash?: string | null
          paid_at?: string | null
          payment_received_txc?: number
          payment_required_txc?: number | null
          payment_tx_hash?: string | null
          renditions?: Json | null
          report_count?: number
          size_bytes?: number
          source?: string
          source_kind?: string | null
          status?: string
          thumbnail_cid?: string | null
          title?: string
          transcode_completed_at?: string | null
          transcode_error?: string | null
          transcode_job_id?: string | null
          transcode_started_at?: string | null
          transcode_status?: string | null
          transcript_cid?: string | null
          transcript_text?: string | null
          tx_hash?: string | null
          unpin_after?: string | null
          unpinned_at?: string | null
          video_wallet?: string | null
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "videos_live_stream_id_fkey"
            columns: ["live_stream_id"]
            isOneToOne: false
            referencedRelation: "live_streams"
            referencedColumns: ["id"]
          },
        ]
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
      wallet_login_challenges: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          ip_address: string | null
          nonce: string
          one_time_token: string | null
          signature: string | null
          signed_at: string | null
          status: Database["public"]["Enums"]["wallet_challenge_status"]
          user_agent: string | null
          wallet_address: string | null
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip_address?: string | null
          nonce: string
          one_time_token?: string | null
          signature?: string | null
          signed_at?: string | null
          status?: Database["public"]["Enums"]["wallet_challenge_status"]
          user_agent?: string | null
          wallet_address?: string | null
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip_address?: string | null
          nonce?: string
          one_time_token?: string | null
          signature?: string | null
          signed_at?: string | null
          status?: Database["public"]["Enums"]["wallet_challenge_status"]
          user_agent?: string | null
          wallet_address?: string | null
        }
        Relationships: []
      }
      wallet_notification_prefs: {
        Row: {
          created_at: string
          email: string | null
          email_verified_at: string | null
          email_verify_expires_at: string | null
          email_verify_token: string | null
          live_deposit_address: string | null
          live_deposit_derivation_index: number | null
          live_deposit_received_txc: number
          live_eligible: boolean
          live_max_concurrent_minutes: number
          live_rate_txc_per_minute: number | null
          notify_expiry: boolean
          telegram_chat_id: number | null
          telegram_pairing_code: string | null
          telegram_pairing_expires_at: string | null
          telegram_username: string | null
          updated_at: string
          wallet: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          email_verified_at?: string | null
          email_verify_expires_at?: string | null
          email_verify_token?: string | null
          live_deposit_address?: string | null
          live_deposit_derivation_index?: number | null
          live_deposit_received_txc?: number
          live_eligible?: boolean
          live_max_concurrent_minutes?: number
          live_rate_txc_per_minute?: number | null
          notify_expiry?: boolean
          telegram_chat_id?: number | null
          telegram_pairing_code?: string | null
          telegram_pairing_expires_at?: string | null
          telegram_username?: string | null
          updated_at?: string
          wallet: string
        }
        Update: {
          created_at?: string
          email?: string | null
          email_verified_at?: string | null
          email_verify_expires_at?: string | null
          email_verify_token?: string | null
          live_deposit_address?: string | null
          live_deposit_derivation_index?: number | null
          live_deposit_received_txc?: number
          live_eligible?: boolean
          live_max_concurrent_minutes?: number
          live_rate_txc_per_minute?: number | null
          notify_expiry?: boolean
          telegram_chat_id?: number | null
          telegram_pairing_code?: string | null
          telegram_pairing_expires_at?: string | null
          telegram_username?: string | null
          updated_at?: string
          wallet?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      next_video_wallet_index: { Args: never; Returns: number }
      purge_expired_wallet_challenges: { Args: never; Returns: undefined }
    }
    Enums: {
      live_stream_status:
        | "scheduled"
        | "starting"
        | "live"
        | "ending"
        | "ended"
        | "archived"
      wallet_challenge_status: "pending" | "signed" | "consumed" | "expired"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      live_stream_status: [
        "scheduled",
        "starting",
        "live",
        "ending",
        "ended",
        "archived",
      ],
      wallet_challenge_status: ["pending", "signed", "consumed", "expired"],
    },
  },
} as const
