import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { ArrowRight, Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { useSendOtp, useVerifyOtp } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/auth-context";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormMessage, FormLabel } from "@/components/ui/form";
import { loginSchema, otpSchema } from "@/lib/validations";
import { useToast } from "@/hooks/use-toast";

export default function Login() {
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [, setLocation] = useLocation();
  const { setAccount } = useAuth();
  const { toast } = useToast();

  const sendOtp = useSendOtp();
  const verifyOtp = useVerifyOtp();

  const phoneForm = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { phone: "" },
  });

  const otpForm = useForm<z.infer<typeof otpSchema>>({
    resolver: zodResolver(otpSchema),
    defaultValues: { phone: "", otp: "" },
  });

  const onPhoneSubmit = (data: z.infer<typeof loginSchema>) => {
    sendOtp.mutate({ data: { phone: data.phone } }, {
      onSuccess: () => {
        setPhone(data.phone);
        otpForm.setValue("phone", data.phone);
        setStep("otp");
        toast({ title: "OTP Sent", description: "Please check your messages." });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Failed to send OTP", description: err.error || "An error occurred" });
      }
    });
  };

  const onOtpSubmit = (data: z.infer<typeof otpSchema>) => {
    verifyOtp.mutate({ data }, {
      onSuccess: (res) => {
        setAccount(res.account);
        setLocation("/");
        toast({ title: "Welcome back", description: `Signed in as ${res.account.name}` });
      },
      onError: (err) => {
        otpForm.setError("otp", { message: err.error || "Invalid OTP" });
      }
    });
  };

  const [countdown, setCountdown] = useState(0);
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown]);

  const handleResend = () => {
    if (countdown > 0) return;
    sendOtp.mutate({ data: { phone } }, {
      onSuccess: () => {
        setCountdown(30);
        toast({ title: "OTP Resent", description: "Please check your messages." });
      }
    });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center space-y-2 text-center">
          <div className="w-12 h-12 bg-primary rounded-xl flex items-center justify-center mb-4">
            <span className="text-primary-foreground text-xl font-bold">W</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">WealthFunds2x</h1>
          <p className="text-muted-foreground text-sm">Professional Trading Cockpit</p>
        </div>

        <div className="relative">
          <div className={`transition-all duration-300 absolute inset-0 ${step === "phone" ? "opacity-100 z-10 translate-x-0" : "opacity-0 z-0 -translate-x-full pointer-events-none"}`}>
            <Card>
              <CardHeader>
                <CardTitle>Sign In</CardTitle>
                <CardDescription>Enter your mobile number to access your account</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...phoneForm}>
                  <form onSubmit={phoneForm.handleSubmit(onPhoneSubmit)} className="space-y-4">
                    <FormField
                      control={phoneForm.control}
                      name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Mobile Number</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter 10-digit number" type="tel" {...field} maxLength={10} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="submit" className="w-full" disabled={sendOtp.isPending}>
                      {sendOtp.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                      Continue <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </form>
                </Form>
              </CardContent>
            </Card>
          </div>

          <div className={`transition-all duration-300 ${step === "otp" ? "opacity-100 z-10 translate-x-0" : "opacity-0 z-0 translate-x-full pointer-events-none"}`}>
            <Card>
              <CardHeader>
                <CardTitle>Verification</CardTitle>
                <CardDescription>Enter the 4-digit code sent to +{phone}</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...otpForm}>
                  <form onSubmit={otpForm.handleSubmit(onOtpSubmit)} className="space-y-6">
                    <FormField
                      control={otpForm.control}
                      name="otp"
                      render={({ field }) => (
                        <FormItem className="flex flex-col items-center">
                          <FormControl>
                            <InputOTP maxLength={4} {...field}>
                              <InputOTPGroup>
                                <InputOTPSlot index={0} className="w-14 h-14 text-xl" />
                                <InputOTPSlot index={1} className="w-14 h-14 text-xl" />
                                <InputOTPSlot index={2} className="w-14 h-14 text-xl" />
                                <InputOTPSlot index={3} className="w-14 h-14 text-xl" />
                              </InputOTPGroup>
                            </InputOTP>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="submit" className="w-full" disabled={verifyOtp.isPending || otpForm.watch("otp").length !== 4}>
                      {verifyOtp.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                      Verify & Sign In
                    </Button>
                  </form>
                </Form>
              </CardContent>
              <CardFooter className="flex justify-between items-center text-sm text-muted-foreground bg-muted/30 py-4">
                <button type="button" onClick={() => setStep("phone")} className="hover:text-foreground">
                  Change number
                </button>
                <button type="button" onClick={handleResend} disabled={countdown > 0} className={`hover:text-foreground ${countdown > 0 ? "opacity-50" : ""}`}>
                  {countdown > 0 ? `Resend in ${countdown}s` : "Resend code"}
                </button>
              </CardFooter>
            </Card>
          </div>
        </div>
      </div>
      <div className="absolute bottom-8 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
        <ShieldCheck className="w-4 h-4" />
        Encrypted & Secure Connection
      </div>
    </div>
  );
}
