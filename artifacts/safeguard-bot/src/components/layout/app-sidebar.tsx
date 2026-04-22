import { Link, useLocation } from "wouter"
import { ShieldCheck, LayoutDashboard, Sun, Moon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useTheme } from "@/components/theme-provider"

const navItems = [
  { title: "My Bots", href: "/", icon: LayoutDashboard },
]

export function AppSidebar() {
  const [location] = useLocation()
  const { theme, setTheme } = useTheme()

  return (
    <Sidebar>
      <SidebarHeader className="h-16 flex items-center px-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 font-bold text-sidebar-foreground">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500 text-white shadow-sm">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm leading-none">Buy Alert Bot</div>
            <div className="text-[10px] font-normal text-muted-foreground leading-none mt-0.5">Multi-chain</div>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={location === item.href} tooltip={item.title}>
                    <Link href={item.href} className="flex items-center gap-3">
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <div className="p-3 mt-auto border-t border-sidebar-border">
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs font-medium rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sidebar-foreground transition-colors"
          data-testid="button-toggle-theme"
        >
          {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
      <SidebarRail />
    </Sidebar>
  )
}
