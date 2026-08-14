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
      categories: {
        Row: {
          created_at: string
          erp_code: string
          id: number
          is_active: boolean
          name: Json
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          erp_code: string
          id?: never
          is_active?: boolean
          name: Json
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          erp_code?: string
          id?: never
          is_active?: boolean
          name?: Json
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
      is_staff: { Args: never; Returns: boolean }
      my_company_id: { Args: never; Returns: string }
      price_cents_for: {
        Args: {
          p: Database["public"]["Tables"]["products"]["Row"]
          tier: number
        }
        Returns: number
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
