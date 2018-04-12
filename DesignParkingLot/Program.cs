using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace DesignParkingLot
{
    class Program
    {
        static void Main(string[] args)
        {
            ParkingLot parkingLot = new ParkingLot(500, 1000, 100);
        }
    }

    public enum VehicalSize
    {
        Small,
        Medium,
        Large
    }
    public class ParkingLot
    {
        private Dictionary<Ticket, Spot> ticketRecorder = new Dictionary<Ticket, Spot>();
        private List<Spot> small = new List<Spot>();
        private List<Spot> medium = new List<Spot>();
        private List<Spot> large = new List<Spot>();

        public ParkingLot(int smallSpot, int mediumSpot, int largeSpot)
        {
            small = CreateSpot(smallSpot, VehicalSize.Small);
            medium = CreateSpot(mediumSpot, VehicalSize.Medium);
            large = CreateSpot(largeSpot, VehicalSize.Large);
        }

        private List<Spot> CreateSpot(int count, VehicalSize size)
        {
            List<Spot> list = new List<Spot>();
            for (int i = 0; i < count; i++)
            {
                list.Add(new Spot(size));
            }

            return list;
        }

        private Spot FindSpot(Vehical vehical)
        {
            if (vehical == null) return null;

            if (vehical.vehicalSize == VehicalSize.Small)
            {
                foreach (var spot in small)
                {
                    if (spot.IsEmpty)
                    {
                        return spot;
                    }
                }
            }
            else if (vehical.vehicalSize == VehicalSize.Medium)
            {
                foreach (var spot in medium)
                {
                    if (spot.IsEmpty)
                    {
                        return spot;
                    }
                }
            }
            else
            {
                foreach (var spot in large)
                {
                    if (spot.IsEmpty)
                    {
                        return spot;
                    }
                }
            }

            return null;
        }

        public Ticket Park(Vehical vehical)
        {
            Spot spot = FindSpot(vehical);
            if (spot != null)
            {
                Ticket ticket = new Ticket();
                ticket.Id = spot.GetHashCode();
                ticket.parkTime = DateTime.Now;
                ticketRecorder.Add(ticket, spot);
                return ticket;
            }

            return null;
        }

        public Vehical Leave(Ticket ticket)
        {
            if (ticket != null && ticketRecorder.ContainsKey(ticket))
            {
                Spot spot = ticketRecorder[ticket];
                Vehical v = spot.Leave();
                return v;
            }
            return null;
        }
    }

    public class Ticket
    {
        public int Id;
        public DateTime parkTime;
    }

    public class Spot
    {
        private VehicalSize size = VehicalSize.Small;
        public Vehical parkedVehical;
        public bool IsEmpty { get { return parkedVehical == null; } }
        public Spot(VehicalSize vehicalSize)
        {
            size = vehicalSize;
        }

        public void Park(Vehical vehical)
        {
            if (IsEmpty)
            {
                parkedVehical = vehical;
            }
        }

        public Vehical Leave()
        {
            if (!IsEmpty)
            {
                var vehical = parkedVehical;
                parkedVehical = null;
                return vehical;
            }

            return null;
        }
    }

    public class Vehical
    {
        public VehicalSize vehicalSize = VehicalSize.Small;
        public Vehical(VehicalSize size)
        {
            vehicalSize = size;
        }
    }
}
