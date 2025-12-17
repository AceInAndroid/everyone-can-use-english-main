import { Navigate } from "react-router-dom";
import { AppSettingsProviderContext } from "@renderer/context";
import { useContext } from "react";

export const AuthenticatedPage = ({
  children,
  redirectPath = "/",
}: {
  children: React.ReactNode;
  redirectPath?: string;
}) => {
  const { initialized, user } = useContext(AppSettingsProviderContext);

  if (!initialized) {
    return <Navigate to="/landing" replace />;
  }

  if (!user || user.isGuest) {
    return <Navigate to={redirectPath} replace />;
  }

  return children;
};

