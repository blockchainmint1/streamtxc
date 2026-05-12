import { useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import { shortenHash } from "@/lib/fees";
import { Wallet, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function WalletButton() {
  const { address, connect, disconnect } = useWallet();

  if (!address) {
    return (
      <Button onClick={connect} variant="default" className="font-mono">
        <Wallet className="mr-2 h-4 w-4" /> Connect Wallet
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="font-mono">
          <Wallet className="mr-2 h-4 w-4" />
          {shortenHash(address)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="font-mono">
        <DropdownMenuItem
          onClick={() => navigator.clipboard.writeText(address)}
        >
          Copy address
        </DropdownMenuItem>
        <DropdownMenuItem onClick={disconnect}>
          <LogOut className="mr-2 h-4 w-4" /> Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}