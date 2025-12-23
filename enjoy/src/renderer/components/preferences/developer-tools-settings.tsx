import { useContext, useState } from "react";
import { AppSettingsProviderContext } from "@renderer/context";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui";
import { Bug } from "lucide-react";
import { toast } from "@renderer/components/ui/use-toast";

export const DeveloperToolsSettings = () => {
  const { EnjoyApp } = useContext(AppSettingsProviderContext);
  const [opening, setOpening] = useState(false);

  const openDevTools = async () => {
    if (!EnjoyApp?.app?.openDevTools) {
      toast({
        variant: "destructive",
        title: "Unavailable",
        description: "DevTools API is not available in this environment.",
      });
      return;
    }
    try {
      setOpening(true);
      await EnjoyApp.app.openDevTools();
      toast({
        title: "Developer Tools opened",
        description: "Check the window for the DevTools panel.",
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Failed to open DevTools",
        description: err?.message || String(err),
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bug className="h-4 w-4" />
          Developer Tools
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Open the Electron DevTools for debugging issues.
        </p>
        <Button onClick={openDevTools} disabled={opening} className="gap-2">
          <Bug className="h-4 w-4" />
          {opening ? "Opening..." : "Open DevTools"}
        </Button>
      </CardContent>
    </Card>
  );
};
