import React from "react";
import { useAuth } from "@/contexts/auth-context";
import { useLogout } from "@workspace/api-client-react";
import { useTheme } from "@/components/theme-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, LogOut, ShieldCheck, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Profile() {
  const { account, clearAuth } = useAuth();
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        clearAuth();
        toast({ title: "Logged out successfully" });
      },
      onError: () => {
        // Clear anyway to ensure safe fallback
        clearAuth();
      }
    });
  };

  if (!account) return null;

  return (
    <div className="max-w-xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile & Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your account preferences</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
              <User className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-bold">{account.name}</h2>
              <p className="text-muted-foreground flex items-center gap-1 font-mono">
                +{account.maskedMobileNumber}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={account.isActive ? "default" : "destructive"} className="uppercase text-xs">
                  {account.isActive ? "Active Account" : "Inactive"}
                </Badge>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-profit" />
                  Verified
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Appearance</CardTitle>
          <CardDescription>Customize how the panel looks</CardDescription>
        </CardHeader>
        <CardContent className="p-6 pt-0 space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="font-medium">Dark Mode</div>
              <div className="text-sm text-muted-foreground">Essential for reduced eye strain</div>
            </div>
            <Switch 
              checked={theme === "dark"} 
              onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")} 
            />
          </div>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0">
          <Button 
            variant="destructive" 
            className="w-full sm:w-auto" 
            onClick={handleLogout}
            disabled={logout.isPending}
          >
            {logout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogOut className="w-4 h-4 mr-2" />}
            Sign Out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
