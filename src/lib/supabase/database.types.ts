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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      bridge_status: {
        Row: {
          detail: Json | null
          job: string
          last_run_at: string
          ok: boolean
        }
        Insert: {
          detail?: Json | null
          job: string
          last_run_at: string
          ok: boolean
        }
        Update: {
          detail?: Json | null
          job?: string
          last_run_at?: string
          ok?: boolean
        }
        Relationships: []
      }
      categories: {
        Row: {
          created_at: string
          erp_code: string
          id: number
          is_active: boolean
          name: Json
          parent_label: Json | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          erp_code: string
          id?: never
          is_active?: boolean
          name: Json
          parent_label?: Json | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          erp_code?: string
          id?: never
          is_active?: boolean
          name?: Json
          parent_label?: Json | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      companies: {
        Row: {
          address: string | null
          cif: string | null
          codcli: number | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          phone: string | null
          postal_code: string | null
          tarcli: number
          updated_at: string
        }
        Insert: {
          address?: string | null
          cif?: string | null
          codcli?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          tarcli?: number
          updated_at?: string
        }
        Update: {
          address?: string | null
          cif?: string | null
          codcli?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          tarcli?: number
          updated_at?: string
        }
        Relationships: []
      }
      favorites: {
        Row: {
          company_id: string
          created_at: string
          product_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          product_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "favorites_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "favorites_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "favorites_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products_priced"
            referencedColumns: ["id"]
          },
        ]
      }
      order_events: {
        Row: {
          actor: string | null
          created_at: string
          detail: Json | null
          event: string
          id: number
          order_id: string
        }
        Insert: {
          actor?: string | null
          created_at?: string
          detail?: Json | null
          event: string
          id?: never
          order_id: string
        }
        Update: {
          actor?: string | null
          created_at?: string
          detail?: Json | null
          event?: string
          id?: never
          order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_events_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          codart: string
          id: number
          is_erp_excluded: boolean
          is_weighed: boolean
          line_total_cents: number
          name: Json
          order_id: string
          product_id: string | null
          qty: number
          sort_order: number
          unit: string
          unit_price_cents: number
        }
        Insert: {
          codart: string
          id?: never
          is_erp_excluded?: boolean
          is_weighed?: boolean
          line_total_cents: number
          name: Json
          order_id: string
          product_id?: string | null
          qty: number
          sort_order?: number
          unit: string
          unit_price_cents: number
        }
        Update: {
          codart?: string
          id?: never
          is_erp_excluded?: boolean
          is_weighed?: boolean
          line_total_cents?: number
          name?: Json
          order_id?: string
          product_id?: string | null
          qty?: number
          sort_order?: number
          unit?: string
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products_priced"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          albaran_at: string | null
          bridge_claim_token: string | null
          bridge_claimed_at: string | null
          client_token: string | null
          company_id: string
          confirmed_at: string | null
          created_at: string
          customer_note: string | null
          delivery_date: string | null
          id: string
          injected_at: string | null
          numalb: number | null
          numped: number | null
          order_number: number
          placed_by: string | null
          request_hash: string | null
          staff_note: string | null
          status: string
          subtotal_cents: number
          updated_at: string
        }
        Insert: {
          albaran_at?: string | null
          bridge_claim_token?: string | null
          bridge_claimed_at?: string | null
          client_token?: string | null
          company_id: string
          confirmed_at?: string | null
          created_at?: string
          customer_note?: string | null
          delivery_date?: string | null
          id?: string
          injected_at?: string | null
          numalb?: number | null
          numped?: number | null
          order_number?: number
          placed_by?: string | null
          request_hash?: string | null
          staff_note?: string | null
          status?: string
          subtotal_cents?: number
          updated_at?: string
        }
        Update: {
          albaran_at?: string | null
          bridge_claim_token?: string | null
          bridge_claimed_at?: string | null
          client_token?: string | null
          company_id?: string
          confirmed_at?: string | null
          created_at?: string
          customer_note?: string | null
          delivery_date?: string | null
          id?: string
          injected_at?: string | null
          numalb?: number | null
          numped?: number | null
          order_number?: number
          placed_by?: string | null
          request_hash?: string | null
          staff_note?: string | null
          status?: string
          subtotal_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_placed_by_fkey"
            columns: ["placed_by"]
            isOneToOne: false
            referencedRelation: "portal_users"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_users: {
        Row: {
          company_id: string
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          locale: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          display_name?: string | null
          id: string
          is_active?: boolean
          locale?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          locale?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portal_users_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          base_sku: string
          category_id: number | null
          codart: string
          created_at: string
          erp_synced_at: string | null
          id: string
          image_url: string | null
          is_available: boolean
          is_current_variant: boolean
          is_erp_excluded: boolean
          is_orderable: boolean | null
          is_weighed: boolean
          iva_rate: number
          name: Json
          price_1_cents: number | null
          price_2_cents: number | null
          price_3_cents: number | null
          price_4_cents: number | null
          price_5_cents: number | null
          price_6_cents: number | null
          sort_order: number
          unit: string
          units_per_case: number | null
          updated_at: string
          variant_suffix: string
        }
        Insert: {
          base_sku: string
          category_id?: number | null
          codart: string
          created_at?: string
          erp_synced_at?: string | null
          id?: string
          image_url?: string | null
          is_available?: boolean
          is_current_variant?: boolean
          is_erp_excluded?: boolean
          is_orderable?: boolean | null
          is_weighed?: boolean
          iva_rate?: number
          name: Json
          price_1_cents?: number | null
          price_2_cents?: number | null
          price_3_cents?: number | null
          price_4_cents?: number | null
          price_5_cents?: number | null
          price_6_cents?: number | null
          sort_order?: number
          unit?: string
          units_per_case?: number | null
          updated_at?: string
          variant_suffix?: string
        }
        Update: {
          base_sku?: string
          category_id?: number | null
          codart?: string
          created_at?: string
          erp_synced_at?: string | null
          id?: string
          image_url?: string | null
          is_available?: boolean
          is_current_variant?: boolean
          is_erp_excluded?: boolean
          is_orderable?: boolean | null
          is_weighed?: boolean
          iva_rate?: number
          name?: Json
          price_1_cents?: number | null
          price_2_cents?: number | null
          price_3_cents?: number | null
          price_4_cents?: number | null
          price_5_cents?: number | null
          price_6_cents?: number | null
          sort_order?: number
          unit?: string
          units_per_case?: number | null
          updated_at?: string
          variant_suffix?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_users: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          is_active?: boolean
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      products_priced: {
        Row: {
          base_sku: string | null
          category_id: number | null
          codart: string | null
          id: string | null
          image_url: string | null
          is_available: boolean | null
          is_current_variant: boolean | null
          is_erp_excluded: boolean | null
          is_orderable: boolean | null
          is_weighed: boolean | null
          iva_rate: number | null
          name: Json | null
          price_cents: number | null
          sort_order: number | null
          unit: string | null
          units_per_case: number | null
          variant_suffix: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      bridge_claim_confirmed: {
        Args: {
          p_claim_token: string
          p_lease_seconds?: number
          p_limit?: number
        }
        Returns: Json
      }
      bridge_mark_albaran: {
        Args: { p_numalb: number; p_order_id: string }
        Returns: boolean
      }
      bridge_mark_injected: {
        Args: { p_claim_token: string; p_numped: number; p_order_id: string }
        Returns: boolean
      }
      create_order: {
        Args: {
          p_client_token?: string
          p_delivery_date?: string
          p_lines: Json
          p_note?: string
        }
        Returns: Json
      }
      price_cents_for: {
        Args: {
          p: Database["public"]["Tables"]["products"]["Row"]
          tier: number
        }
        Returns: number
      }
      staff_cancel_order: {
        Args: { p_order_id: string; p_reason?: string }
        Returns: boolean
      }
      staff_confirm_order: {
        Args: { p_order_id: string; p_staff_note?: string }
        Returns: boolean
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
