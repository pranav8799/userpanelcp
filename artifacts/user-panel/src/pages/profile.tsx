import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { useLogout } from "@workspace/api-client-react";
import { useTheme } from "@/components/theme-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Form, FormControl, FormField, FormItem, FormMessage, FormLabel, FormDescription } from "@/components/ui/form";
import { Loader2, LogOut, ShieldCheck, User, Pencil, X, Check, Phone } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── helpers ────────────────────────────────────────────────────────────
function getErrorMessage(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.error === "string") return anyErr.error;
    if (typeof anyErr.message === "string") return anyErr.message;
  }
  return fallback;
}

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data as T;
}

// ── validation ─────────────────────────────────────────────────────────
// apiKey / secretKey are optional here — leaving them blank means "keep as is".
const detailsSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name"),
  apiKey: z.string().trim().optional(),
  secretKey: z.string().trim().optional(),
});
type DetailsForm = z.infer<typeof detailsSchema>;

const newMobileSchema = z.object({
  mobile: z.string().trim().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number"),
});
type NewMobileForm = z.infer<typeof newMobileSchema>;

const mobileOtpSchema = z.object({
  otp: z.string().length(4, "Enter the 4-digit code"),
});
type MobileOtpForm = z.infer<typeof mobileOtpSchema>;

interface AccountShape {
  id: number;
  name: string;
  mobileNumber?: string;
  maskedMobileNumber: string;
  isActive: boolean;
  apiKeyMasked?: string;
}

export default function Profile() {
  const { account, setAccount, clearAuth } = useAuth();
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();

  const [editingDetails, setEditingDetails] = useState(false);
  const [mobileStep, setMobileStep] = useState<"idle" | "enter" | "otp">("idle");
  const [pendingMobile, setPendingMobile] = useState("");
  const [countdown, setCountdown] = useState(0);

  // ── Name / API key / Secret key ─────────────────────────────────────
  const detailsForm = useForm<DetailsForm>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { name: account?.name ?? "", apiKey: "", secretKey: "" },
  });

  const updateDetails = useMutation({
    mutationFn: (data: DetailsForm) =>
      requestJson<AccountShape>("/api/account", "PATCH", {
        name: data.name,
        ...(data.apiKey ? { apiKey: data.apiKey } : {}),
        ...(data.secretKey ? { secretKey: data.secretKey } : {}),
      }),
    onSuccess: (updated) => {
      setAccount({ ...(account as object), ...updated } as typeof account & object);
      toast({ title: "Profile updated" });
      setEditingDetails(false);
      detailsForm.reset({ name: updated.name, apiKey: "", secretKey: "" });
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: getErrorMessage(err, "Could not update your details"),
      });
    },
  });

  const onDetailsSubmit = (data: DetailsForm) => updateDetails.mutate(data);

  const cancelEditDetails = () => {
    detailsForm.reset({ name: account?.name ?? "", apiKey: "", secretKey: "" });
    setEditingDetails(false);
  };

  // ── Mobile number change (OTP-gated) ────────────────────────────────
  const newMobileForm = useForm<NewMobileForm>({
    resolver: zodResolver(newMobileSchema),
    defaultValues: { mobile: "" },
  });

  const mobileOtpForm = useForm<MobileOtpForm>({
    resolver: zodResolver(mobileOtpSchema),
    defaultValues: { otp: "" },
  });

  const sendMobileOtp = useMutation({
    mutationFn: (newMobile: string) =>
      requestJson<{ success: boolean }>("/api/account/mobile/send-otp", "POST", { newMobile }),
  });

  const verifyMobileOtp = useMutation({
    mutationFn: (data: { newMobile: string; otp: string }) =>
      requestJson<AccountShape>("/api/account/mobile/verify-otp", "POST", data),
  });

  const openMobileChange = () => {
    newMobileForm.reset({ mobile: "" });
    setMobileStep("enter");
  };

  const cancelMobileChange = () => {
    newMobileForm.reset({ mobile: "" });
    mobileOtpForm.reset({ otp: "" });
    setPendingMobile("");
    setCountdown(0);
    setMobileStep("idle");
  };

  const onNewMobileSubmit = (data: NewMobileForm) => {
    sendMobileOtp.mutate(data.mobile, {
      onSuccess: () => {
        setPendingMobile(data.mobile);
        setMobileStep("otp");
        setCountdown(30);
        toast({ title: "OTP Sent", description: "Please check your messages." });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Failed to send OTP",
          description: getErrorMessage(err, "An error occurred"),
        });
      },
    });
  };

  const onMobileOtpSubmit = (data: MobileOtpForm) => {
    verifyMobileOtp.mutate(
      { newMobile: pendingMobile, otp: data.otp },
      {
        onSuccess: (updated) => {
          setAccount({ ...(account as object), ...updated } as typeof account & object);
          toast({ title: "Mobile number updated" });
          cancelMobileChange();
        },
        onError: (err) => {
          mobileOtpForm.setError("otp", { message: getErrorMessage(err, "Invalid OTP") });
        },
      }
    );
  };

  useState(() => {
    // no-op placeholder to keep hook order stable if countdown effect is added later
  });

  // simple countdown ticker
  useState(() => {
    return undefined;
  });

  const handleResendMobileOtp = () => {
    if (countdown > 0 || !pendingMobile) return;
    sendMobileOtp.mutate(pendingMobile, {
      onSuccess: () => {
        setCountdown(30);
        toast({ title: "OTP Resent", description: "Please check your messages." });
      },
    });
  };

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        clearAuth();
        toast({ title: "Logged out successfully" });
      },
      onError: () => {
        clearAuth();
      },
    });
  };

  if (!account) return null;

  return (
    <div className="max-w-xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile & Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your account preferences</p>
      </div>

      {/* ── Identity summary ─────────────────────────────────────────── */}
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

      {/* ── Editable: name / API key / secret key ───────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg">Account Details</CardTitle>
            <CardDescription>Your name and CoinSwitch API credentials</CardDescription>
          </div>
          {!editingDetails && (
            <Button variant="ghost" size="sm" onClick={() => setEditingDetails(true)}>
              <Pencil className="w-4 h-4 mr-2" />
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="pt-0">
          {!editingDetails ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Full Name</span>
                <span className="font-medium">{account.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">CoinSwitch API Key</span>
                <span className="font-mono">
                  {"apiKeyMasked" in account ? (account as AccountShape).apiKeyMasked : "••••••••"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">CoinSwitch Secret Key</span>
                <span className="font-mono">••••••••</span>
              </div>
            </div>
          ) : (
            <Form {...detailsForm}>
              <form onSubmit={detailsForm.handleSubmit(onDetailsSubmit)} className="space-y-4">
                <FormField
                  control={detailsForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Enter your name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={detailsForm.control}
                  name="apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>CoinSwitch API Key</FormLabel>
                      <FormControl>
                        <Input placeholder="Leave blank to keep current key" {...field} />
                      </FormControl>
                      <FormDescription>Only fill this in if you want to replace your API key.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={detailsForm.control}
                  name="secretKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>CoinSwitch Secret Key</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="Leave blank to keep current key" {...field} />
                      </FormControl>
                      <FormDescription>Only fill this in if you want to replace your secret key.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-center gap-2 pt-2">
                  <Button type="submit" disabled={updateDetails.isPending}>
                    {updateDetails.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4 mr-2" />
                    )}
                    Save Changes
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={cancelEditDetails}
                    disabled={updateDetails.isPending}
                  >
                    <X className="w-4 h-4 mr-2" />
                    Cancel
                  </Button>
                </div>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>

      {/* ── Mobile number change (OTP-gated) ─────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Mobile Number</CardTitle>
          <CardDescription>Changing your number requires OTP verification</CardDescription>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          {mobileStep === "idle" && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono text-sm">
                <Phone className="w-4 h-4 text-muted-foreground" />+{account.maskedMobileNumber}
              </div>
              <Button variant="outline" size="sm" onClick={openMobileChange}>
                Change
              </Button>
            </div>
          )}

          {mobileStep === "enter" && (
            <Form {...newMobileForm}>
              <form onSubmit={newMobileForm.handleSubmit(onNewMobileSubmit)} className="space-y-4">
                <FormField
                  control={newMobileForm.control}
                  name="mobile"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>New Mobile Number</FormLabel>
                      <FormControl>
                        <Input placeholder="Enter 10-digit number" type="tel" {...field} maxLength={10} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-center gap-2">
                  <Button type="submit" size="sm" disabled={sendMobileOtp.isPending}>
                    {sendMobileOtp.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : null}
                    Send OTP
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={cancelMobileChange}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Form>
          )}

          {mobileStep === "otp" && (
            <Form {...mobileOtpForm}>
              <form onSubmit={mobileOtpForm.handleSubmit(onMobileOtpSubmit)} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Enter the 4-digit code sent to +{pendingMobile}
                </p>
                <FormField
                  control={mobileOtpForm.control}
                  name="otp"
                  render={({ field }) => (
                    <FormItem className="flex flex-col items-center">
                      <FormControl>
                        <InputOTP maxLength={4} {...field}>
                          <InputOTPGroup>
                            <InputOTPSlot index={0} className="w-12 h-12 text-lg" />
                            <InputOTPSlot index={1} className="w-12 h-12 text-lg" />
                            <InputOTPSlot index={2} className="w-12 h-12 text-lg" />
                            <InputOTPSlot index={3} className="w-12 h-12 text-lg" />
                          </InputOTPGroup>
                        </InputOTP>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-center justify-between">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={verifyMobileOtp.isPending || mobileOtpForm.watch("otp").length !== 4}
                  >
                    {verifyMobileOtp.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : null}
                    Verify & Update
                  </Button>
                  <div className="flex items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={handleResendMobileOtp}
                      disabled={countdown > 0}
                      className={`text-muted-foreground hover:text-foreground ${countdown > 0 ? "opacity-50" : ""}`}
                    >
                      {countdown > 0 ? `Resend in ${countdown}s` : "Resend code"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelMobileChange}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>

      {/* ── Appearance ───────────────────────────────────────────────── */}
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

      {/* ── Danger zone ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          {/* <CardTitle className="text-lg text-destructive">Danger Zone</CardTitle> */}
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