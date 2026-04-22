import { Link } from "wouter"
import { Button } from "@/components/ui/button"
import { ChevronLeft } from "lucide-react"

export default function Alerts() {
  return (
    <div className="p-6 max-w-4xl mx-auto text-center py-20">
      <p className="text-muted-foreground mb-4">Alerts are now shown per bot.</p>
      <Link href="/">
        <Button variant="outline" className="gap-2">
          <ChevronLeft className="w-4 h-4" />
          Go to My Bots
        </Button>
      </Link>
    </div>
  )
}
